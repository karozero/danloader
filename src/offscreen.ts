import { resolveOutput } from "./domain/media-output.js";
import { assertOutputEnabled } from "./application/output-capabilities.js";
import { createDownloadEngine } from "./application/download-engine.js";
import { loadManifest } from "./infrastructure/load-manifest.js";
import { getDownloadService } from "./services/registry.js";
import { safeName } from "./core/media.js";
import {
  destinationDirectory,
  writeVideoFile,
} from "./infrastructure/destination-store.js";
const tasks = new Map();
const send = (msg) => chrome.runtime.sendMessage(msg);
const engine = createDownloadEngine({
  loadManifest,
  prepareUrls: async (media, urls) => {
    const result = await send({ action: "prepare-urls", media, urls });
    if (!result?.ok)
      throw new Error(
        result?.error || "Не удалось подготовить заголовки запросов.",
      );
  },
});
const boot = (async () => {
  const root = await navigator.storage.getDirectory();
  for await (const [name] of root.entries())
    if (name.startsWith("dvd-")) await root.removeEntry(name).catch(() => {});
})();
async function start(msg) {
  const output = resolveOutput(msg.output, msg.container);
  assertOutputEnabled(output);
  await boot;
  if (tasks.size) throw new Error("Загрузчик занят.");
  const { job } = msg;
  const task = {
    worker: null,
    youtube: getDownloadService(msg.media).id === "youtube",
    file: `dvd-${job.id}.${output.container}`,
    blob: null,
    cancelled: false,
    saving: false,
    controller: new AbortController(),
  };
  tasks.set(job.id, task);
  let prepared;
  try {
    prepared = await engine.download(
      msg.media,
      msg.selection,
      task.controller.signal,
      output,
    );
  } catch (error) {
    await release(job.id);
    throw error;
  }
  if (task.cancelled || !tasks.has(job.id))
    throw new Error("Скачивание отменено.");
  const { media, variant, live, duration } = prepared;
  const worker = (task.worker = new Worker("worker.js", { type: "module" }));
  worker.onmessage = async ({ data }) => {
    try {
      if (data.type === "youtube-media") {
        const result = await send({
          action: "youtube-media",
          id: job.id,
          operation: data.operation,
          url: data.url,
          body: data.body,
        });
        task.worker?.postMessage({
          type: "youtube-reply",
          uid: data.uid,
          ...result,
        });
      } else if (data.type === "progress")
        await send({ action: "progress", id: job.id, ...data, live });
      else if (data.type === "done") {
        if (task.cancelled) {
          await release(job.id);
          return;
        }
        const root = await navigator.storage.getDirectory();
        const file = await (await root.getFileHandle(task.file)).getFile();
        if (!file.size) throw new Error("Загрузчик создал пустой файл.");
        const saving = await send({
          action: "progress",
          id: job.id,
          status: "saving",
          bytes: file.size,
          percent: null,
        });
        if (!saving?.ok)
          throw new Error(saving?.error || "Не удалось начать сохранение.");
        if (msg.destination?.mode === "directory") {
          task.saving = true;
          const directory = await destinationDirectory(msg.destination.id);
          const saved = await writeVideoFile(
            directory,
            file,
            safeName(job.title, data.extension),
            {
              signal: task.controller.signal,
              onProgress: (savedBytes) =>
                send({
                  action: "progress",
                  id: job.id,
                  status: "saving",
                  savedBytes,
                  percent: file.size ? (savedBytes / file.size) * 100 : null,
                }).catch(() => {}),
            },
          );
          const response = await send({
            action: "folder-saved",
            id: job.id,
            ...saved,
          });
          if (!response?.ok)
            throw new Error(
              response?.error || "Не удалось подтвердить сохранение.",
            );
          return;
        }
        task.blob = URL.createObjectURL(file);
        task.saving = true;
        const response = await send({
          action: "save",
          id: job.id,
          url: task.blob,
          extension: data.extension,
        });
        if (!response?.ok)
          throw new Error(response?.error || "Браузер не сохранил файл.");
      } else if (data.type === "error") throw new Error(data.error);
    } catch (error) {
      await fail(job.id, error.message, task.cancelled);
    }
  };
  worker.onerror = () =>
    fail(
      job.id,
      "Ошибка Worker. Проверьте доступное место и повторите загрузку.",
      task.cancelled,
    );
  worker.postMessage({
    type: "start",
    file: task.file,
    media,
    variant,
    container: output.container,
    output,
    duration,
    live,
  });
}
async function release(id) {
  const task = tasks.get(id);
  if (!task) return;
  tasks.delete(id);
  task.controller.abort();
  task.worker?.terminate();
  if (task.youtube)
    await send({ action: "youtube-media", id, operation: "cancel" }).catch(
      () => {},
    );
  if (task.blob) URL.revokeObjectURL(task.blob);
  const root = await navigator.storage.getDirectory();
  // Worker termination releases its sync handle asynchronously.
  for (let i = 0; i < 5; i++) {
    try {
      await root.removeEntry(task.file);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  for (const suffix of [
    ".video",
    ".audio",
    ...Array.from({ length: 4 }, (_, i) => ".hls-part-" + i),
  ])
    await root.removeEntry(task.file + suffix).catch(() => {});
}
async function fail(id, error, cancelled = false) {
  await release(id);
  await send({ action: "ended", id, error, cancelled }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (
    sender.id !== chrome.runtime.id ||
    sender.tab ||
    (sender.url && sender.url !== chrome.runtime.getURL("service.js")) ||
    msg?.target !== "offscreen"
  )
    return;
  const task = (async () => {
    if (msg.action === "snapshot") return [...tasks.keys()];
    if (msg.action === "inspect") {
      const r = await engine.inspect(msg.media);
      return {
        ...r,
        variants: r.variants.map((v) => ({
          label: v.label,
          height: v.height,
          bandwidth: v.bandwidth,
        })),
        urls: undefined,
      };
    }
    if (msg.action === "start") {
      await start(msg);
      return true;
    }
    if (msg.action === "release") {
      await release(msg.id);
      return true;
    }
    if (msg.action === "cancel") {
      const t = tasks.get(msg.id);
      if (t) {
        t.cancelled = true;
        await fail(msg.id, "Скачивание отменено.", true);
      }
      return true;
    }
    if (msg.action === "stop") {
      const t = tasks.get(msg.id);
      if (t?.worker) t.worker.postMessage({ type: "stop" });
      return true;
    }
    throw new Error("Неизвестная команда загрузчика.");
  })();
  task.then(
    (value) => reply({ ok: true, value }),
    (error) => reply({ ok: false, error: error.message }),
  );
  return true;
});
