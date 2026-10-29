import { downloadHls } from "./application/download-hls.js";
import { createSegmentSpool } from "./infrastructure/segment-spool.js";
import { resolveOutput } from "./domain/media-output.js";
import { assertOutputEnabled } from "./application/output-capabilities.js";
import type { WorkerStart, WorkerRequest } from "./domain/media.js";
import { downloadTracks } from "./application/download-tracks.js";
import { observeResponse } from "./core/network-progress.js";
import { httpUrl, isVendorUrl, hasMetaByteRange } from "./core/media.js";
import { downloadNativeSabr } from "./services/youtube/native-sabr.js";
import { remuxLocalTracks, remuxLocalMedia } from "./infrastructure/remux.js";
import { mountLocalInputs } from "./infrastructure/local-reader.js";
import { requireVideoMp4 } from "./core/mp4.js";
globalThis.LibAV = {}; // Prevent the library from replacing our Worker message handler.
globalThis.MAX_FETCH_ATTEMPTS = 3;
globalThis.MAX_READ_ATTEMPTS = 3;
globalThis.MutateUrl = (url) => url;
globalThis.FindPngSliceIndex = () => -1;
const controller = new AbortController();
let networkBytes = 0,
  reportNetwork = () => {};
const pageRequests = new Map();
function requestPage(operation, data = {}) {
  return new Promise((resolve, reject) => {
    const uid = crypto.randomUUID(),
      timer = setTimeout(() => {
        pageRequests.delete(uid);
        reject(new Error("Истекло ожидание страницы YouTube."));
      }, 40000);
    pageRequests.set(uid, { resolve, reject, timer });
    postMessage({ type: "youtube-media", uid, operation, ...data });
  });
}
let av,
  stopped = false,
  live = false,
  overrides = new Map(),
  lastNetworkError = "",
  credentials: RequestCredentials = "include";

globalThis.DoAbortableSleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ aborted: true });
      return;
    }
    const onAbort = () => {
      clearTimeout(timeout_id);
      resolve({ aborted: true, timeout_id });
    };
    const timeout_id = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve({ timed_out: true, timeout_id });
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

globalThis.FetchWithRetry = async (
  url,
  headers,
  attempts = 3,
  timeout = 20000,
  delay = 500,
  bypass = false,
  signal,
) => {
  if (!httpUrl(url) || isVendorUrl(url))
    return new Error("Недопустимый источник видео.");
  if (overrides.has(url))
    return new Response(overrides.get(url), {
      headers: {
        "Content-Type": /<MPD[\s>]/.test(overrides.get(url))
          ? "application/dash+xml"
          : "application/vnd.apple.mpegurl",
      },
    });
  for (let attempt = 0; attempt < Math.min(attempts, 3); attempt++) {
    const timeoutController = new AbortController();
    const timer = setTimeout(
      () => timeoutController.abort(),
      Math.min(timeout || 20000, 30000),
    );
    try {
      const signals = [
        controller.signal,
        timeoutController.signal,
        signal,
      ].filter(Boolean);
      const response = await fetch(url, {
        headers,
        credentials,
        cache: bypass ? "reload" : "default",
        signal: AbortSignal.any(signals),
      });
      if (response.ok)
        return observeResponse(response, (bytes) => {
          networkBytes += bytes;
          reportNetwork();
        });
      await response.body?.cancel();
      lastNetworkError = `HTTP ${response.status}`;
      if (response.status < 500 && response.status !== 429)
        return { err_status: response.status };
    } catch (error) {
      if (controller.signal.aborted || signal?.aborted)
        return { aborted: true };
      lastNetworkError = timeoutController.signal.aborted
        ? "Истекло время ожидания источника."
        : "Ошибка сети или недоступный источник.";
    } finally {
      clearTimeout(timer);
    }
    if (attempt + 1 < Math.min(attempts, 3))
      await globalThis.DoAbortableSleep(
        Math.min(delay * 2 ** attempt, 4000),
        controller.signal,
      );
  }
  return new Error(lastNetworkError || "Не удалось получить видео.");
};

async function run(data: WorkerStart) {
  const output = resolveOutput(data.output, data.container);
  assertOutputEnabled(output);
  const { file, media, variant, duration } = data;
  const container = output.container;
  live = data.live;
  credentials = "include";
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(file, { create: true });
  let writer = await handle.createSyncAccessHandle();
  writer.truncate(0);
  let size = 0,
    interval,
    localInputs,
    closeInputs,
    downloadedBytes = 0;
  const progress = (
    percent = null,
    status = localInputs ? "finalizing" : "downloading",
  ) =>
    postMessage({
      type: "progress",
      status,
      bytes: downloadedBytes || networkBytes || size,
      outputBytes: size,
      percent,
    });
  let currentPercent = null,
    lastNetworkNotice = 0,
    lastHlsNotice = 0;
  reportNetwork = () => {
    if (Date.now() - lastNetworkNotice >= 200) {
      lastNetworkNotice = Date.now();
      progress(currentPercent);
    }
  };
  try {
    progress();
    if (media.kind === "file" && !variant.audioUrl && container !== "mkv") {
      if (hasMetaByteRange(variant.url))
        throw new Error(
          "Это ссылка на отдельный диапазон Instagram. Выберите целый ролик из его метаданных.",
        );
      const response = await globalThis.FetchWithRetry(
        variant.url,
        {},
        3,
        20000,
        500,
        false,
        controller.signal,
      );
      if (!(response instanceof Response))
        throw new Error(lastNetworkError || "Видео недоступно.");
      // A captured byte-range URL must never silently become a fragment download.
      if (response.status === 206) {
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
          response.headers.get("content-range") || "",
        );
        if (
          !range ||
          Number(range[1]) !== 0 ||
          Number(range[2]) + 1 !== Number(range[3])
        )
          throw new Error(
            "Источник вернул только фрагмент видео. Используйте потоковый вариант.",
          );
      }
      const total = Number(response.headers.get("content-length")) || 0;
      const reader = response.body.getReader();
      let last = 0;
      try {
        while (true) {
          let timer;
          const chunk = await Promise.race([
            reader.read(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("Источник перестал передавать данные.")),
                30000,
              );
            }),
          ]).finally(() => clearTimeout(timer));
          if (chunk.done) break;
          writer.write(chunk.value, { at: size });
          size += chunk.value.length;
          if (Date.now() - last > 400) {
            progress(total ? Math.min(99, (size / total) * 100) : null);
            last = Date.now();
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      if (total && total !== size)
        throw new Error("Источник передал неполный файл.");
      if (!size) throw new Error("Источник передал пустой файл.");
      const mime = response.headers.get("content-type") || media.mime;
      if (/text\/html|application\/json/i.test(mime))
        throw new Error("Источник вернул страницу ошибки вместо видео.");
      writer.flush();
      writer.close();
      writer = null;
      const extension = /webm/i.test(mime)
        ? "webm"
        : /matroska/i.test(mime)
          ? "mkv"
          : /quicktime/i.test(mime)
            ? "mov"
            : "mp4";
      if (extension === "mp4")
        await requireVideoMp4(await handle.getFile(), {
          requireAudio: media.hasAudio === true,
        });
      progress(100, "finalizing");
      postMessage({ type: "done", extension });
      return;
    }
    if (
      ["sabr", "tracks"].includes(media.kind) ||
      (media.kind === "hls" && variant.hls && !live)
    ) {
      const inputs = [];
      try {
        const suffixes =
          media.kind === "hls" && !variant.hls.audio
            ? [".video"]
            : [".video", ".audio"];
        for (const suffix of suffixes) {
          const handle = await root.getFileHandle(file + suffix, {
              create: true,
            }),
            sink = await handle.createSyncAccessHandle();
          sink.truncate(0);
          inputs.push({ handle, sink, size: 0 });
        }
        if (media.kind === "hls")
          await downloadHls(variant.hls, {
            signal: controller.signal,
            fetcher: (url, signal, range) =>
              globalThis.FetchWithRetry(
                url,
                range
                  ? {
                      Range:
                        "bytes=" +
                        range.offset +
                        "-" +
                        (range.offset + range.length - 1),
                    }
                  : {},
                3,
                20000,
                500,
                false,
                signal,
              ),
            createSpool: (slot) =>
              createSegmentSpool(root, file + ".hls-part-" + slot),
            sinks: {
              video: (chunk) => {
                inputs[0].sink.write(chunk, { at: inputs[0].size });
                inputs[0].size += chunk.length;
              },
              audio: variant.hls.audio
                ? (chunk) => {
                    inputs[1].sink.write(chunk, { at: inputs[1].size });
                    inputs[1].size += chunk.length;
                  }
                : undefined,
            },
            onProgress: (bytes, percent) => {
              downloadedBytes = bytes;
              currentPercent = percent;
              if (Date.now() - lastHlsNotice >= 100 || percent >= 99) {
                lastHlsNotice = Date.now();
                progress(percent);
              }
            },
          });
        else if (media.kind === "sabr")
          await downloadNativeSabr({
            videoId: media.videoId,
            video: variant.sabrVideo,
            audio: variant.sabrAudio,
            duration,
            requestPage,
            videoSink: (chunk) => {
              const input = inputs[0];
              input.sink.write(chunk, { at: input.size });
              input.size += chunk.length;
            },
            audioSink: (chunk) => {
              const input = inputs[1];
              input.sink.write(chunk, { at: input.size });
              input.size += chunk.length;
            },
            onProgress: (bytes, percent) => {
              downloadedBytes = bytes;
              progress(percent);
            },
          });
        else
          await downloadTracks({
            tracks: variant.tracks,
            fetcher: (url) =>
              globalThis.FetchWithRetry(
                url,
                {},
                3,
                20000,
                500,
                false,
                controller.signal,
              ),
            sinks: {
              video: (chunk) => {
                const input = inputs[0];
                input.sink.write(chunk, { at: input.size });
                input.size += chunk.length;
              },
              audio: (chunk) => {
                const input = inputs[1];
                input.sink.write(chunk, { at: input.size });
                input.size += chunk.length;
              },
            },
            onProgress: (bytes, percent) => {
              downloadedBytes = bytes;
              currentPercent = percent;
              progress(percent);
            },
          });
      } finally {
        for (const input of inputs) {
          input.sink.flush();
          input.sink.close();
        }
      }
      if (inputs.some((input) => !input.size))
        throw new Error("Источник не передал обе дорожки.");
      localInputs = [
        { name: "sabr-video", file: file + ".video" },
        ...(inputs.length > 1
          ? [{ name: "sabr-audio", file: file + ".audio" }]
          : []),
      ];
      progress(null, "finalizing");
    }
    if (media.manifestText) overrides.set(media.url, media.manifestText);
    if (variant.manifestText) overrides.set(media.url, variant.manifestText);
    const { default: createLibAV } = await import("./vendor/libav.mjs");
    av = await createLibAV({
      wasmurl: new URL("./vendor/libav.wasm", import.meta.url).href,
    });
    av.onwrite = (_name, offset, bytes) => {
      writer.write(bytes, { at: offset });
      size = Math.max(size, offset + bytes.length);
    };
    await av.jsfetch_set_read_timeout(30000);
    await av.jsfetch_set_fetch_timeout(20000);
    await av.jsfetch_set_initial_retry_delay(500);
    await av.jsfetch_set_is_http(!["hls", "dash"].includes(media.kind));
    await av.mkwriterdev(file);
    const args = ["-nostdin", "-analyzeduration", "10M"];
    if (media.kind === "hls") args.push("-f", "hls");
    if (media.kind === "dash") args.push("-f", "dash");
    if (localInputs) {
      closeInputs = await mountLocalInputs(av, root, localInputs);
      for (const input of localInputs) args.push("-i", input.name);
    } else {
      args.push("-i", `jsfetch:${variant.url || media.url}`);
      if (variant.audioUrl) args.push("-i", `jsfetch:${variant.audioUrl}`);
    }
    args.push(
      "-map",
      "0:v:0",
      "-map",
      variant.audioUrl || localInputs ? "1:a:0?" : "0:a:0?",
      "-c:v",
      "copy",
      "-c:a",
      "copy",
      "-avoid_negative_ts",
      "make_zero",
    );
    args.push("-y", file);
    if (!localInputs)
      interval = setInterval(() => {
        try {
          const ms =
            typeof av._ffmpeg_get_out_time_ms === "function"
              ? av._ffmpeg_get_out_time_ms()
              : 0;
          currentPercent =
            duration && !live && Number.isFinite(ms) && ms > 0
              ? Math.min(99, (ms / (duration * 1000)) * 100)
              : null;
        } catch {}
        progress(currentPercent);
      }, 200);
    progress();
    let code = 0,
      elapsed;
    if (localInputs && media.kind === "hls")
      elapsed = await remuxLocalMedia(av, {
        inputs: [
          {
            name: "sabr-video",
            tracks: variant.hls.audio ? ["video"] : ["video", "audio"],
          },
          ...(variant.hls.audio
            ? [{ name: "sabr-audio", tracks: ["audio" as const] }]
            : []),
        ],
        requireAudio: Boolean(variant.hls.audio) || media.hasAudio === true,
        normalizeStart: true,
        file,
        container,
        duration,
        onProgress: (percent) => progress(percent),
      });
    else if (localInputs)
      elapsed = await remuxLocalTracks(av, {
        video: "sabr-video",
        audio: "sabr-audio",
        file,
        container,
        duration,
        onProgress: (percent) => progress(percent),
      });
    else {
      code = await av.ffmpeg(args);
      elapsed = await av.ffmpeg_get_out_time_ms();
    }
    clearInterval(interval);
    if (code !== 0 && !(stopped && live && size > 1024))
      throw new Error(
        `Не удалось завершить видео (${lastNetworkError || "код " + code}). Попробуйте контейнер MKV или обновите источник.`,
      );
    if (duration && !live && elapsed < duration * 1000 * 0.9)
      throw new Error(
        "Получена только часть видео. Файл не сохранён как завершённый.",
      );
    if (size < 1024)
      throw new Error("Недостаточно данных для сохранения видео.");
    writer.flush();
    writer.close();
    writer = null;
    if (container === "mp4")
      await requireVideoMp4(await handle.getFile(), {
        requireAudio: Boolean(variant.audioUrl) || media.hasAudio === true,
      });
    progress(100, "finalizing");
    postMessage({ type: "done", extension: container });
  } finally {
    clearInterval(interval);
    closeInputs?.();
    if (writer) writer.close();
  }
}
self.onmessage = ({ data }: MessageEvent<WorkerRequest>) => {
  if (data.type === "youtube-reply") {
    const pending = pageRequests.get(data.uid);
    if (pending) {
      pageRequests.delete(data.uid);
      clearTimeout(pending.timer);
      data.ok
        ? pending.resolve(data.value)
        : pending.reject(new Error(data.error || "Ошибка SABR."));
    }
  } else if (data.type === "start")
    run(data).catch((error) =>
      postMessage({ type: "error", error: error.message }),
    );
  else if (data.type === "stop" && live) {
    stopped = true;
    av?.ffmpeg_interrupt();
  }
};
