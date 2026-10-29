import { mountDestinationPicker } from "./presentation/destination-picker.js";
import { mountLanguagePicker } from "./presentation/language-picker.js";
import type { Media, DownloadJob, QualityResult } from "./domain/media.js";
import {
  initializeLanguage,
  t,
  translateMarkup,
} from "./presentation/language.js";
import { createQualityCache } from "./application/quality-cache.js";
import { displayHost } from "./core/media.js";
import { durationText } from "./core/discovery.js";
const initialLanguage = await initializeLanguage();
const el = (id) => document.getElementById(id),
  selections = new Map<string, QualityResult>(),
  formState = new Map<
    string,
    { quality?: string; container?: string; name?: string }
  >();
let tabId,
  signature = "",
  busy = false,
  autoInspecting = false;
const qualityCache = createQualityCache((id) => call("inspect", { id }), {
  onChange: () => {
    signature = "";
    refresh().catch((e) => error(e.message));
  },
});
const bytes = (n) =>
  n >= 1073741824
    ? `${(n / 1073741824).toFixed(2)} ${t("ГБ")}`
    : n >= 1048576
      ? `${(n / 1048576).toFixed(1)} ${t("МБ")}`
      : `${Math.round(n / 1024)} ${t("КБ")}`;
const labels = {
  queued: t("В очереди"),
  preparing: t("Подготовка"),
  downloading: t("Скачивание"),
  finalizing: t("Объединение"),
  saving: t("Сохранение"),
  complete: t("Готово"),
  failed: t("Ошибка"),
  cancelled: t("Отменено"),
};
function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function error(message) {
  el("error").textContent = message || "";
  el("error").hidden = !message;
}
async function call(action, data = {}) {
  const response = await chrome.runtime.sendMessage({
    target: "ui",
    action,
    tabId,
    ...data,
  });
  if (!response?.ok)
    throw new Error(response?.error || t("Сервис недоступен."));
  return response.value;
}
function guarded(fn) {
  return async () => {
    try {
      error("");
      await fn();
    } catch (e) {
      error(e.message);
    }
  };
}
function field(text, control) {
  const label = element("label", null, "setting");
  label.append(element("span", text), control);
  return label;
}
function renderMedia(media: Media[]) {
  el("media").replaceChildren();
  if (!media.length) {
    el("media").append(
      element(
        "p",
        t(
          "Видео пока не найдено. Запустите его на странице и обновите список.",
        ),
        "empty",
      ),
    );
    return;
  }
  for (const item of media) {
    const state = formState.get(item.id) || {};
    formState.set(item.id, state);
    const card = element("article", null, "card");
    card.dataset.mediaId = item.id;
    card.dataset.current = String(item.isCurrent === true);
    const top = element("div", null, "card-top"),
      visual = element("div", null, "media-visual"),
      settings = element("div", null, "card-settings");
    if (item.thumbnail) {
      const image = element("img");
      image.src = item.thumbnail;
      image.alt = t("Обложка видео");
      image.loading = "lazy";
      image.referrerPolicy = "no-referrer";
      image.onerror = () => image.remove();
      visual.append(image);
    } else visual.append(element("span", "▧", "image-placeholder"));
    const duration = durationText(item.duration);
    if (duration) visual.append(element("span", duration, "duration"));
    const quality = element("select");
    quality.setAttribute("aria-label", t("Качество видео"));
    const revision = item.qualityRevision || 0;
    let qualityState = ["instagram", "kinescope"].includes(item.provider)
      ? qualityCache.get(item.id, revision)
      : null;
    if (
      ["instagram", "kinescope"].includes(item.provider) &&
      !qualityState &&
      !busy &&
      !autoInspecting
    ) {
      autoInspecting = true;
      qualityCache
        .resolve(item.id, revision)
        .catch(() => {})
        .finally(() => {
          autoInspecting = false;
          signature = "";
          refresh().catch(() => {});
        });
      qualityState = qualityCache.get(item.id, revision);
    }
    const qualityReady = qualityState?.status === "ready";
    let variants = selections.get(item.id)?.variants ||
      (item.entries?.length
        ? item.entries
        : item.qualities?.length
          ? item.qualities
          : null) || [
        {
          label:
            item.provider === "youtube"
              ? item.resolutionError
                ? t("Недоступно")
                : t("Загрузка…")
              : item.quality || t("Исходное"),
        },
      ];
    if (["instagram", "kinescope"].includes(item.provider))
      variants = qualityReady
        ? qualityState.result.variants
        : [
            {
              label:
                qualityState?.status === "error"
                  ? t("Ошибка разбора")
                  : !qualityState
                    ? t("Ожидание разбора")
                    : t("Загрузка качеств…"),
            },
          ];
    quality.disabled =
      ["instagram", "kinescope"].includes(item.provider) && !qualityReady;
    quality.append(
      ...variants.map((v, index) => new Option(t(v.label), String(index))),
    );
    quality.value = String(
      Math.max(0, Math.min(Number(state.quality) || 0, variants.length - 1)),
    );
    state.quality = quality.value;
    quality.onchange = () => (state.quality = quality.value);
    const inspect = element("button", "↻", "inspect");
    inspect.title = t("Получить доступные качества");
    inspect.setAttribute("aria-label", t("Получить доступные качества"));
    inspect.disabled =
      busy || item.needsAudio || qualityState?.status === "loading";
    inspect.onclick = guarded(async () => {
      inspect.disabled = true;
      try {
        if (["instagram", "kinescope"].includes(item.provider))
          await qualityCache.resolve(item.id, revision, true);
        else {
          const data = await call("inspect", { id: item.id });
          selections.set(item.id, data);
          signature = "";
        }
        await refresh();
      } finally {
        inspect.disabled =
          busy || item.needsAudio || qualityState?.status === "loading";
      }
    });
    const qualityRow = element("div", null, "quality-control");
    qualityRow.append(quality, inspect);
    settings.append(field(t("Качество"), qualityRow));
    const container = element("select");
    container.setAttribute("aria-label", t("Контейнер"));
    container.append(new Option("MP4", "mp4"), new Option("MKV", "mkv"));
    container.value = state.container || "mp4";
    container.onchange = () => (state.container = container.value);
    settings.append(field(t("Формат"), container));
    const meta = element(
      "div",
      `${item.size ? bytes(item.size) + " · " : ""}${displayHost(item.url)}`,
      "source",
    );
    meta.title = displayHost(item.url);
    settings.append(meta);
    top.append(visual, settings);
    card.append(top);
    if (item.isCurrent)
      card.append(element("p", t("Текущий Reel"), "current-reel"));
    if (item.needsAudio)
      card.append(
        element(
          "p",
          t(
            "Включите воспроизведение со звуком, чтобы обнаружить аудиодорожку.",
          ),
          "card-note",
        ),
      );
    if (qualityState?.error)
      card.append(element("p", qualityState.error, "card-note"));
    if (item.resolutionError) {
      const note = element("p", item.resolutionError, "card-note");
      card.append(note);
    }
    const bottom = element("div", null, "card-bottom"),
      name = element("input");
    name.type = "text";
    name.value = state.name ?? item.title ?? t("Видео");
    name.title = name.value;
    name.setAttribute("aria-label", t("Имя файла"));
    name.oninput = () => {
      state.name = name.value;
      name.title = name.value;
    };
    const start = element("button", t("Скачать"), "primary");
    start.disabled =
      item.needsAudio ||
      (item.provider === "youtube" && !item.entries?.length) ||
      (["instagram", "kinescope"].includes(item.provider) && !qualityReady);
    start.title = start.disabled
      ? item.resolutionError ||
        item.accessError ||
        (item.needsAudio
          ? t("Пока не найдена аудиодорожка.")
          : ["instagram", "kinescope"].includes(item.provider)
            ? t("Ожидается разбор качеств.")
            : t("Нет доступных ссылок для скачивания."))
      : busy
        ? t("Добавить скачивание в общую очередь")
        : t("Скачать видео");
    start.onclick = guarded(async () => {
      start.disabled = true;
      try {
        await call("start", {
          id: item.id,
          selection: Number(quality.value),
          container: container.value,
          filename: name.value,
        });
        await refresh();
      } finally {
        start.disabled =
          item.needsAudio ||
          (item.provider === "youtube" && !item.entries?.length) ||
          (["instagram", "kinescope"].includes(item.provider) && !qualityReady);
      }
    });
    bottom.append(name, start);
    card.append(bottom);
    el("media").append(card);
  }
}
function renderJobs(jobs: DownloadJob[]) {
  el("downloads").replaceChildren();
  for (const job of jobs) {
    const card = element("article", null, "job"),
      line = element("div", null, "job-line"),
      title = element(
        "span",
        (job.otherTab ? t("Другая вкладка: ") : "") + job.title,
        "job-title",
      );
    title.title = title.textContent;
    const meta = element(
      "span",
      `${t(labels[job.status] || job.status)}${job.percent != null ? " · " + Math.round(job.percent) + "%" : ""} · ${job.bytes ? bytes(job.bytes) : t("ожидание данных")}${job.live ? " · LIVE" : ""}`,
      "job-meta",
    );
    meta.title = job.folderName ? t("Папка: ") + job.folderName : "";
    line.append(title, meta);
    if (!["complete", "failed", "cancelled"].includes(job.status)) {
      const controls = element("div", null, "job-controls");
      if (job.live && job.status === "downloading") {
        const stop = element("button", t("Завершить"));
        stop.onclick = guarded(() => call("stop", { id: job.id }));
        controls.append(stop);
      }
      const cancel = element("button", "×");
      cancel.title = t("Отменить скачивание");
      cancel.setAttribute("aria-label", t("Отменить скачивание"));
      cancel.onclick = guarded(async () => {
        await call("cancel", { id: job.id });
        await refresh();
      });
      controls.append(cancel);
      line.append(controls);
      const progress = element("progress");
      progress.max = 100;
      progress.setAttribute("aria-label", t("Прогресс скачивания"));
      if (job.percent != null) progress.value = job.percent;
      card.append(line, progress);
    } else card.append(line);
    if (job.error) card.append(element("p", job.error, "job-error"));
    el("downloads").append(card);
  }
}
async function refresh() {
  const data = await call("list");
  busy = data.busy;
  const next = JSON.stringify(data.media) + busy;
  if (next !== signature) {
    signature = next;
    renderMedia(data.media);
  }
  renderJobs(data.jobs);
}
const { refresh: refreshDestination } = mountDestinationPicker(error);
el("refresh").onclick = guarded(async () => {
  await chrome.tabs.sendMessage(tabId, { action: "rescan" }).catch(() => {});
  signature = "";
  await refresh();
  await refreshDestination();
});
el("clear").onclick = guarded(async () => {
  await call("clear");
  await refresh();
});
chrome.runtime.onMessage.addListener((message) => {
  if (message?.action === "state-updated") {
    refresh().catch(() => {});
    return;
  }
  if (message?.action === "destination-updated")
    refreshDestination().catch((e) => error(e.message));
});
translateMarkup(document.body);
mountLanguagePicker(
  initialLanguage,
  async (language) => {
    translateMarkup(document.body);
    signature = "";
    await refreshDestination();
    await refresh();
  },
  error,
);
const openTabs = await chrome.tabs.query({ currentWindow: true });
const tab =
  openTabs.find((t) => t.active && /^https?:/.test(t.url || "")) ||
  openTabs
    .filter((t) => /^https?:/.test(t.url || ""))
    .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
tabId = tab?.id;
await guarded(async () => {
  await refreshDestination();
  await refresh();
})();
setInterval(() => refresh().catch(() => {}), 1000);
