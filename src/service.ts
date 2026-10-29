import { videoOutput } from "./domain/media-output.js";
import { getDownloadService } from "./services/registry.js";
import { applyProgress } from "./application/job-progress.js";
import { offscreen } from "./infrastructure/offscreen-client.js";
import type { Media, DownloadJob } from "./domain/media.js";
import {
  httpUrl,
  mediaKind,
  canonicalMediaUrl,
  playbackInfo,
  boundedText,
  isVendorUrl,
  terminal,
  safeName,
  hasMetaByteRange,
} from "./core/media.js";
import { visibleMedia, thumbnailUrl, segmentUrl } from "./core/discovery.js";
import { currentDestination } from "./infrastructure/destination-store.js";
import {
  resolveYouTube,
  youtubeId,
  youtubePageId,
  nativeYouTubeUrl,
} from "./services/youtube/resolver.js";

const tabs = new Map<number, Map<string, Media>>(),
  jobs = new Map<string, DownloadJob>(),
  requestHeaders = new Map(),
  urlHeaders = new Map();
const pageMetadata = new Map(),
  manifestLoads = new Map();
const youtubeLoads = new Map();
const youtubePlayback = new Map();
let persistTimer,
  notificationTimer,
  draining = false,
  serial = Promise.resolve();
const ready = (async () => {
  await chrome.storage.session.setAccessLevel({
    accessLevel: "TRUSTED_CONTEXTS",
  });
  const saved = (await chrome.storage.session.get(["tabs", "jobs"])) as {
    tabs?: [number, [string, Media][]][];
    jobs?: DownloadJob[];
  };
  for (const [id, values] of saved.tabs || []) tabs.set(id, new Map(values));
  for (const job of saved.jobs || []) jobs.set(job.id, job);
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [1] });
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (!contexts.length) {
    for (const job of jobs.values())
      if (!terminal(job.status)) {
        job.status = "failed";
        job.error = "Браузер завершил загрузчик. Запустите скачивание заново.";
        delete job.request;
      }
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    if (rules.length)
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: rules.filter((r) => r.id >= 100).map((r) => r.id),
      });
  } else {
    const snapshot = await chrome.runtime
      .sendMessage({ target: "offscreen", action: "snapshot" })
      .catch(() => null);
    const active = new Set(snapshot?.value || []);
    for (const job of jobs.values())
      if (
        !terminal(job.status) &&
        job.status !== "queued" &&
        !active.has(job.id)
      ) {
        job.status = "failed";
        job.error =
          "Задача загрузчика потеряна после перезапуска. Повторите скачивание.";
        delete job.request;
      }
  }
  await chrome.storage.session.set({ jobs: [...jobs.values()] });
})();
ready.then(() => scheduleDrain()).catch(() => {});

function persist() {
  if (!notificationTimer)
    notificationTimer = setTimeout(() => {
      notificationTimer = null;
      chrome.runtime.sendMessage({ action: "state-updated" }).catch(() => {});
    }, 100);
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    chrome.storage.session
      .set({
        tabs: [...tabs].map(([id, values]) => [id, [...values]]),
        jobs: [...jobs.values()],
      })
      .catch(() => {});
  }, 250);
}
function badge(tabId) {
  chrome.action
    .setBadgeText({
      tabId,
      text: String(
        visibleMedia([...(tabs.get(tabId)?.values() || [])]).length || "",
      ),
    })
    .catch(() => {});
}
function rememberHeaders(details) {
  if (details.tabId < 0 || !httpUrl(details.url)) return;
  const allowed = new Set(["referer", "origin", "authorization", "cookie"]);
  const headers = (details.requestHeaders || [])
    .filter(
      (h) => allowed.has(h.name.toLowerCase()) && typeof h.value === "string",
    )
    .map((h) => ({ name: h.name.toLowerCase(), value: h.value }));
  requestHeaders.set(details.requestId, { headers, time: Date.now() });
  urlHeaders.set(canonicalMediaUrl(details.url), { headers, time: Date.now() });
  for (const [url, entry] of urlHeaders)
    if (Date.now() - entry.time > 600000) urlHeaders.delete(url);
  if (urlHeaders.size > 500) urlHeaders.delete(urlHeaders.keys().next().value);
  for (const [id, entry] of requestHeaders)
    if (Date.now() - entry.time > 600000) requestHeaders.delete(id);
  if (requestHeaders.size > 500)
    requestHeaders.delete(requestHeaders.keys().next().value);
}
chrome.webRequest.onSendHeaders.addListener(
  rememberHeaders,
  { urls: ["http://*/*", "https://*/*"] },
  ["requestHeaders", "extraHeaders"],
);
chrome.webRequest.onResponseStarted.addListener(
  (details) => {
    if (
      details.tabId < 0 ||
      details.statusCode < 200 ||
      details.statusCode >= 400
    )
      return;
    const headers = Object.fromEntries(
      (details.responseHeaders || []).map((h) => [
        h.name.toLowerCase(),
        h.value,
      ]),
    );
    const mime = headers["content-type"] || "";
    const kind = mediaKind(details.url, mime);
    if (!kind || /mp2t/i.test(mime)) return;
    const playback = playbackInfo(details.url, mime);
    if (playback) {
      if (/^(?:video|audio)\/(?:mp4|webm)(?:;|$)/i.test(mime))
        ready.then(async () => {
          const frame = await chrome.webNavigation
            .getFrame({
              tabId: details.tabId,
              frameId: Math.max(0, details.frameId),
            })
            .catch(() => null);
          const videoId = frame && youtubePageId(frame.url),
            native = nativeYouTubeUrl(details.url);
          if (!videoId || !native) return;
          const key = `${details.tabId}:${videoId}`,
            formats = youtubePlayback.get(key) || [];
          youtubePlayback.set(
            key,
            [native, ...formats.filter((f) => f.itag !== native.itag)].slice(
              0,
              50,
            ),
          );
        });
      return;
    }
    if (hasMetaByteRange(details.url)) return;
    if (kind === "audio" && !playback) return;
    // Do not expose HLS fragments and initialization files as standalone videos.
    if (segmentUrl(details.url)) return;
    const captured = requestHeaders.get(details.requestId);
    if (captured) urlHeaders.set(canonicalMediaUrl(details.url), captured);
    for (const [url, entry] of urlHeaders)
      if (Date.now() - entry.time > 600000) urlHeaders.delete(url);
    if (urlHeaders.size > 500)
      urlHeaders.delete(urlHeaders.keys().next().value);
    const size =
      Number(
        headers["content-range"]?.split("/")[1] || headers["content-length"],
      ) || null;
    ready.then(async () => {
      const frame = await chrome.webNavigation
        .getFrame({
          tabId: details.tabId,
          frameId: Math.max(0, details.frameId),
        })
        .catch(() => null);
      if (
        !frame ||
        (details.documentId && frame.documentId !== details.documentId)
      )
        return;
      addMedia(details.tabId, {
        url: details.url,
        kind,
        mime,
        size,
        source: "network",
        playback,
        frameId: details.frameId,
        pageUrl: frame.url,
      });
    });
  },
  { urls: ["http://*/*", "https://*/*"] },
  ["responseHeaders"],
);

async function readManifest(tabId, item) {
  const key = `${tabId}:${item.url}`;
  if (manifestLoads.has(key) && Date.now() - manifestLoads.get(key) < 30000)
    return;
  manifestLoads.set(key, Date.now());
  while (manifestLoads.size > 100)
    manifestLoads.delete(manifestLoads.keys().next().value);
  try {
    const headers = (urlHeaders.get(item.url)?.headers || []).filter(
      (h) => h.name === "authorization",
    );
    const response = await fetch(item.url, {
      credentials: "include",
      headers: Object.fromEntries(headers.map((h) => [h.name, h.value])),
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) return;
    const reader = response.body.getReader(),
      decoder = new TextDecoder();
    let text = "",
      bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > 1000000) return;
        text += decoder.decode(value, { stream: true });
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    text += decoder.decode();
    if (
      !text.trimStart().startsWith("#EXTM3U") &&
      !/<(?:\w+:)?MPD\b/.test(text)
    )
      return;
    if (tabs.get(tabId)?.has(item.id))
      addMedia(tabId, { ...item, manifestText: text });
  } catch {} // Page-world observation supplies bodies when a CDN rejects an extension refetch.
}

function addMedia(tabId, raw) {
  const url = httpUrl(raw.url);
  if (
    !url ||
    isVendorUrl(url) ||
    !["file", "audio", "hls", "dash", "pair", "youtube"].includes(raw.kind)
  )
    return;
  const pageHost = (() => {
    try {
      return new URL(raw.pageUrl).hostname;
    } catch {
      return "";
    }
  })();
  const provider =
    raw.provider === "youtube" && /(?:^|\.)youtube\.com$/.test(pageHost)
      ? "youtube"
      : raw.provider === "kinescope" && /(?:^|\.)kinescope\.io$/.test(pageHost)
        ? "kinescope"
        : raw.provider === "instagram"
          ? "instagram"
          : undefined;
  if (
    raw.kind === "youtube" &&
    (!provider ||
      !youtubeId(raw.videoId) ||
      youtubePageId(raw.pageUrl) !== raw.videoId)
  )
    return;
  const inline =
    typeof raw.manifestText === "string" && raw.manifestText.length <= 1000000
      ? raw.manifestText
      : undefined;
  if (raw.manifestText && !inline) return;
  const groupId = boundedText(raw.groupId, 180);
  let entryBudget = 1000000;
  const entries = Array.isArray(raw.entries)
    ? raw.entries
        .slice(0, 30)
        .map((e) => {
          const text =
            typeof e?.manifestText === "string" &&
            e.manifestText.length <= entryBudget
              ? e.manifestText
              : undefined;
          entryBudget -= text?.length || 0;
          return {
            url: httpUrl(e?.url),
            kind: e?.kind,
            label: boundedText(e?.label, 80),
            audioUrl: httpUrl(e?.audioUrl) || undefined,
            manifestText: text,
            mime: boundedText(e?.mime, 150),
            formatId: boundedText(String(e?.formatId || ""), 100),
            hasAudio: e?.hasAudio,
            width: Number(e?.width) || undefined,
            height: Number(e?.height) || undefined,
            fps: Number(e?.fps) || undefined,
            bitrate: Number(e?.bitrate) || undefined,
          };
        })
        .filter(
          (e) =>
            e.url &&
            !isVendorUrl(e.url) &&
            ["file", "hls", "dash", "pair"].includes(e.kind),
        )
    : undefined;
  const key = groupId
    ? `group:${raw.frameId || 0}:${groupId}`
    : canonicalMediaUrl(url);
  if (!tabs.has(tabId)) tabs.set(tabId, new Map());
  const list = tabs.get(tabId);
  const aliases =
    provider === "instagram" && Array.isArray(raw.aliasGroupIds)
      ? raw.aliasGroupIds
          .filter(
            (v) =>
              typeof v === "string" &&
              v.startsWith("instagram:id:") &&
              v.length <= 180,
          )
          .map((v) => `group:${raw.frameId || 0}:${v}`)
      : [];
  const previous =
    [...list.values()].find((m) => m.key === key) ||
    [...list.values()].find(
      (m) => m.provider === "instagram" && aliases.includes(m.key),
    );
  for (const [id, m] of list)
    if (m !== previous && m.provider === "instagram" && aliases.includes(m.key))
      list.delete(id);
  const metadata = pageMetadata.get(`${tabId}:${raw.frameId || 0}`) || {};
  const item = {
    ...previous,
    id: previous?.id || crypto.randomUUID(),
    key,
    url,
    kind: raw.kind,
    title: boundedText(raw.title || previous?.title || metadata.title),
    mime: boundedText(raw.mime || previous?.mime, 100),
    quality: boundedText(raw.quality || previous?.quality, 60),
    size: Number(raw.size) || previous?.size || null,
    source: boundedText(raw.source || previous?.source || "page", 40),
    manifestText: inline || previous?.manifestText,
    playback: raw.playback || previous?.playback || playbackInfo(url, raw.mime),
    audioUrl: httpUrl(raw.audioUrl) || previous?.audioUrl,
    pageUrl: httpUrl(raw.pageUrl) || previous?.pageUrl,
    frameId: raw.frameId ?? previous?.frameId ?? 0,
    tabId,
    groupId: groupId || previous?.groupId,
    sourceUrls:
      provider === "kinescope" && Array.isArray(raw.sourceUrls)
        ? raw.sourceUrls
            .slice(0, 20)
            .map((url) => httpUrl(url))
            .filter(Boolean)
        : previous?.sourceUrls,
    entries: entries?.length ? entries : previous?.entries,
    thumbnail:
      thumbnailUrl(raw.thumbnail, raw.pageUrl) ||
      previous?.thumbnail ||
      metadata.thumbnail,
    duration:
      Number(raw.duration) > 0 ? Number(raw.duration) : previous?.duration,
    isCurrent: provider === "instagram" ? raw.isCurrent === true : undefined,
    reelCode: boundedText(raw.reelCode, 100) || previous?.reelCode,
    instagramMediaId:
      boundedText(raw.instagramMediaId, 100) || previous?.instagramMediaId,
    qualityRevision:
      (previous?.qualityRevision || 0) +
      ((provider === "instagram" &&
        entries?.length &&
        JSON.stringify(entries) !== JSON.stringify(previous?.entries)) ||
      (provider === "kinescope" &&
        (url !== previous?.url ||
          (inline && inline !== previous?.manifestText)))
        ? 1
        : 0),
    provider: provider || previous?.provider,
    videoId:
      provider === "youtube" || provider === "kinescope"
        ? boundedText(raw.videoId, 100)
        : previous?.videoId,
    accessError:
      provider === "youtube"
        ? boundedText(raw.accessError, 400)
        : previous?.accessError,
    hasAudio:
      typeof raw.hasAudio === "boolean" ? raw.hasAudio : previous?.hasAudio,
    seen: Date.now(),
    drm: raw.drm === true || previous?.drm === true,
  };
  if (item.isCurrent)
    for (const other of list.values())
      if (
        other.provider === "instagram" &&
        other.frameId === item.frameId &&
        other.id !== item.id
      )
        other.isCurrent = false;
  list.set(item.id, item);
  while (list.size > 80) list.delete(list.keys().next().value);
  while (tabs.size > 50) tabs.delete(tabs.keys().next().value);
  let retained = 0;
  for (const [, items] of [...tabs].reverse())
    for (const [id, m] of [...items].reverse()) {
      retained +=
        ((m.manifestText?.length || 0) +
          (m.thumbnail?.length || 0) +
          (m.sourceUrls || []).reduce((sum, url) => sum + url.length, 0) +
          (m.entries || []).reduce(
            (sum, e) =>
              sum +
              (e.manifestText?.length || 0) +
              (e.url?.length || 0) +
              (e.audioUrl?.length || 0),
            0,
          )) *
          2 +
        m.url.length * 2 +
        1200;
      if (retained > 4000000) items.delete(id);
    }
  badge(tabId);
  persist();
  if (
    provider === "youtube" &&
    !item.accessError &&
    (!item.entries?.length || Date.now() - (item.resolvedAt || 0) > 60000) &&
    !youtubeLoads.has(`${tabId}:${item.videoId}`)
  ) {
    const loadKey = `${tabId}:${item.videoId}`;
    const load = resolveYouTube(item.videoId, {
      readPlayer: youtubePageRead(item),
      observed: youtubePlayback.get(`${tabId}:${item.videoId}`) || [],
    })
      .then((info) => {
        const current = tabs.get(tabId)?.get(item.id);
        if (current && !current.accessError)
          Object.assign(current, info, {
            resolutionError: info.unavailableReason,
          });
        persist();
      })
      .catch((error) => {
        const current = tabs.get(tabId)?.get(item.id);
        if (current) current.resolutionError = boundedText(error.message, 400);
        persist();
      })
      .finally(() => youtubeLoads.delete(loadKey));
    youtubeLoads.set(loadKey, load);
  }
  if (!item.manifestText && ["hls", "dash"].includes(item.kind))
    readManifest(tabId, item);
}

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0) {
    tabs.delete(details.tabId);
    for (const key of pageMetadata.keys())
      if (key.startsWith(details.tabId + ":")) pageMetadata.delete(key);
    badge(details.tabId);
    persist();
  }
});
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId === 0) {
    if (/(?:^|\.)instagram\.com$/.test(new URL(details.url).hostname)) {
      for (const item of tabs.get(details.tabId)?.values() || [])
        if (item.provider === "instagram") item.isCurrent = false;
    } else tabs.delete(details.tabId);
    badge(details.tabId);
    persist();
    chrome.tabs
      .sendMessage(details.tabId, { action: "rescan" })
      .catch(() => {});
  }
});
chrome.tabs.onRemoved.addListener((id) => {
  tabs.delete(id);
  persist();
});

function listMedia(tabId) {
  const values = [...(tabs.get(tabId)?.values() || [])];
  return visibleMedia(values)
    .sort((a, b) => Number(b.isCurrent || false) - Number(a.isCurrent || false))
    .map((m) => {
      let audioUrl = m.audioUrl;
      if (!audioUrl && m.playback?.needsAudio)
        audioUrl = values.find(
          (a) => a.playback?.audio && a.playback.group === m.playback.group,
        )?.url;
      return {
        ...m,
        audioUrl,
        needsAudio: m.playback?.needsAudio && !audioUrl,
        manifestText: undefined,
        key: undefined,
        seen: undefined,
      };
    });
}
function getMedia(tabId, id) {
  const m = tabs.get(tabId)?.get(id);
  if (!m) throw new Error("Видео больше не доступно. Обновите список.");
  const summary = listMedia(tabId).find((x) => x.id === id);
  if (summary?.needsAudio)
    throw new Error(
      "Пока обнаружена только видеодорожка. Включите воспроизведение со звуком и обновите список.",
    );
  return { ...m, audioUrl: summary?.audioUrl || m.audioUrl };
}

// Rules are scoped to this extension's requests and the exact observed CDN host.
// Sensitive headers are never copied to another host or written to persistent storage.
async function configureHeaders(media, extraUrls = []) {
  const old = await chrome.declarativeNetRequest.getSessionRules();
  const rules = [],
    seen = new Set();
  for (const url of [
    media.url,
    media.audioUrl,
    ...extraUrls.slice(0, 100),
  ].filter((u) => httpUrl(u))) {
    const origin = new URL(url).origin;
    if (seen.has(origin)) continue;
    seen.add(origin);
    const entry =
      urlHeaders.get(canonicalMediaUrl(url)) ||
      [...urlHeaders]
        .reverse()
        .find(([u]) => new URL(u).origin === origin)?.[1] ||
      (() => {
        const parent = urlHeaders.get(canonicalMediaUrl(media.url));
        return (
          parent && {
            time: parent.time,
            headers: parent.headers.filter((h) =>
              ["referer", "origin"].includes(h.name),
            ),
          }
        );
      })();
    if (!entry || Date.now() - entry.time > 600000 || !entry.headers.length)
      continue;
    const exactOrigin = origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    rules.push({
      id: 100 + rules.length,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: entry.headers.map((h) => ({
          header: h.name,
          operation: "set",
          value: h.value,
        })),
      },
      condition: {
        initiatorDomains: [chrome.runtime.id],
        regexFilter: `^${exactOrigin}/`,
        resourceTypes: ["xmlhttprequest"],
      },
    });
  }
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: old.filter((r) => r.id >= 100).map((r) => r.id),
    addRules: rules,
  });
}

function publicJob(job) {
  const { request, ...summary } = job;
  return summary;
}
function youtubePageRead(item) {
  return async () => {
    const result = await chrome.tabs.sendMessage(
      item.tabId,
      { action: "youtube-player-request", videoId: item.videoId },
      { frameId: item.frameId || 0 },
    );
    if (!result?.ok)
      throw new Error(
        result?.error ||
          "Откройте исходное видео YouTube и обновите страницу, чтобы получить ссылки.",
      );
    return JSON.parse(result.value.json);
  };
}
async function refreshServiceMedia(item: Media, force = false): Promise<Media> {
  const service = getDownloadService(item);
  if (!service.refresh) return item;
  return service.refresh(item, force, {
    readPlayer: youtubePageRead(item),
    observed: youtubePlayback.get(item.tabId + ":" + item.videoId) || [],
    onChange: persist,
  });
}
async function pageMedia(tabId: number, id: string): Promise<Media> {
  const media = getMedia(tabId, id);
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  return { ...media, servicePageUrl: tab?.url || media.pageUrl };
}
function scheduleDrain() {
  queueMicrotask(() => {
    if (draining) return;
    draining = true;
    drain()
      .catch(() => {})
      .finally(() => {
        draining = false;
        if (
          [...jobs.values()].some((j) => j.status === "queued") &&
          ![...jobs.values()].some(
            (j) => !terminal(j.status) && j.status !== "queued",
          )
        )
          scheduleDrain();
      });
  });
}
async function drain() {
  if (
    [...jobs.values()].some((j) => !terminal(j.status) && j.status !== "queued")
  )
    return;
  const job = [...jobs.values()].find((j) => j.status === "queued");
  if (!job) return;
  job.status = "preparing";
  await chrome.storage.session.set({ jobs: [...jobs.values()] });
  try {
    await getDownloadService(job.request.media).prepareQueued?.(job.request, {
      refreshMedia: refreshServiceMedia,
      configureHeaders,
    });
    if (terminal(job.status)) return;
    await configureHeaders(job.request.media);
    if (terminal(job.status)) return;
    await offscreen("start", { job: publicJob(job), ...job.request });
  } catch (error) {
    if (!terminal(job.status)) {
      job.status = "failed";
      job.error = error.message;
    }
    delete job.request;
    persist();
    await offscreen("cancel", { id: job.id }).catch(() => {});
    await clearRules();
    scheduleDrain();
  }
}
async function clearRules() {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: rules.filter((r) => r.id >= 100).map((r) => r.id),
  });
}

async function uiMessage(msg) {
  await ready;
  if (msg.action === "list")
    return {
      media: listMedia(msg.tabId),
      jobs: [...jobs.values()]
        .filter((j) => j.tabId === msg.tabId || !terminal(j.status))
        .map((j) => ({ ...publicJob(j), otherTab: j.tabId !== msg.tabId })),
      busy: [...jobs.values()].some((j) => !terminal(j.status)),
    };
  if (msg.action === "destination") return currentDestination();
  if (msg.action === "inspect") {
    if ([...jobs.values()].some((j) => !terminal(j.status)))
      throw new Error(
        "Дождитесь текущего скачивания перед анализом другого потока.",
      );
    let media = await pageMedia(msg.tabId, msg.id);
    media = await refreshServiceMedia(media, true);
    Object.assign(tabs.get(msg.tabId).get(msg.id), media);
    await configureHeaders(media);
    try {
      return await offscreen("inspect", { media });
    } finally {
      await clearRules();
    }
  }
  if (msg.action === "start") {
    if ([...jobs.values()].filter((j) => !terminal(j.status)).length >= 50)
      throw new Error(
        "В очереди уже 50 файлов. Дождитесь завершения части загрузок.",
      );
    let media = await pageMedia(msg.tabId, msg.id);
    media = await refreshServiceMedia(media);
    Object.assign(tabs.get(msg.tabId).get(msg.id), media);
    const destination = await currentDestination();
    if (
      destination.mode === "directory" &&
      destination.permission !== "granted"
    )
      throw new Error(
        "Выберите папку заново вверху панели, чтобы разрешить сохранение.",
      );
    if (
      JSON.stringify([...jobs.values()].filter((j) => j.request)).length * 2 +
        JSON.stringify(media).length * 2 >
      4000000
    )
      throw new Error(
        "Очередь содержит слишком много данных плейлистов. Дождитесь завершения загрузок.",
      );
    const job: DownloadJob = {
      id: crypto.randomUUID(),
      tabId: msg.tabId,
      title: boundedText(msg.filename || media.title) || "Видео",
      status: "queued",
      bytes: 0,
      started: Date.now(),
      request: {
        output: videoOutput(msg.container),
        media,
        selection: Number.isInteger(msg.selection) ? msg.selection : 0,
        formatId:
          media.entries?.[Number.isInteger(msg.selection) ? msg.selection : 0]
            ?.formatId,
        container: msg.container === "mkv" ? "mkv" : "mp4",
        destination,
      },
    };
    jobs.set(job.id, job);
    persist();
    for (const [id, j] of jobs)
      if (jobs.size > 30 && terminal(j.status)) jobs.delete(id);
    await chrome.storage.session.set({ jobs: [...jobs.values()] });
    scheduleDrain();
    return publicJob(job);
  }
  if (msg.action === "cancel" || msg.action === "stop") {
    const job = jobs.get(msg.id);
    if (job && !terminal(job.status)) {
      if (job.status === "queued" || job.status === "preparing") {
        job.status = "cancelled";
        delete job.request;
        persist();
        await offscreen("cancel", { id: job.id }).catch(() => {});
        scheduleDrain();
        return true;
      }
      if (job.browserId) await chrome.downloads.cancel(job.browserId);
      await offscreen(msg.action, { id: job.id });
    }
    return true;
  }
  if (msg.action === "clear") {
    for (const [id, j] of jobs) if (terminal(j.status)) jobs.delete(id);
    persist();
    return true;
  }
  throw new Error("Неизвестная команда.");
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || sender.id !== chrome.runtime.id || msg.target === "offscreen")
    return;
  const popup = sender.url === chrome.runtime.getURL("popup.html");
  const workerHost =
    sender.url === chrome.runtime.getURL("offscreen.html") && !sender.tab;
  let task;
  if (msg.target === "ui" && popup) {
    // Serialize user mutations: two fast clicks cannot start competing header rules/jobs.
    if (["list", "destination", "cancel", "stop"].includes(msg.action))
      task = uiMessage(msg);
    else {
      task = serial.then(() => uiMessage(msg));
      serial = task.catch(() => {});
    }
  } else if (
    msg.target === "destination" &&
    msg.action === "changed" &&
    popup
  ) {
    task = chrome.runtime
      .sendMessage({ action: "destination-updated" })
      .catch(() => null)
      .then(() => true);
  } else if (
    msg.action === "discover" &&
    sender.tab &&
    Array.isArray(msg.media)
  ) {
    task = ready.then(async () => {
      const frame = await chrome.webNavigation.getFrame({
        tabId: sender.tab.id,
        frameId: sender.frameId,
      });
      if (
        !frame ||
        (sender.documentId && frame.documentId !== sender.documentId)
      )
        return false;
      for (const m of msg.media.slice(0, 50))
        if (m && typeof m === "object")
          addMedia(sender.tab.id, {
            ...m,
            frameId: sender.frameId,
            pageUrl: sender.url,
          });
      return true;
    });
  } else if (msg.action === "page-meta" && sender.tab) {
    task = ready.then(async () => {
      const frame = await chrome.webNavigation.getFrame({
        tabId: sender.tab.id,
        frameId: sender.frameId,
      });
      if (
        !frame ||
        (sender.documentId && frame.documentId !== sender.documentId)
      )
        return false;
      const metadata = {
        title: boundedText(msg.title),
        thumbnail: thumbnailUrl(msg.thumbnail, sender.url),
      };
      pageMetadata.set(`${sender.tab.id}:${sender.frameId}`, metadata);
      for (const item of tabs.get(sender.tab.id)?.values() || [])
        if (item.frameId === sender.frameId) {
          if (!item.title) item.title = metadata.title;
          if (!item.thumbnail) item.thumbnail = metadata.thumbnail;
        }
      persist();
      return true;
    });
  } else if (workerHost && msg.action === "youtube-media") {
    task = ready.then(async () => {
      const job = jobs.get(msg.id);
      if (
        !job ||
        (msg.operation !== "cancel" &&
          (terminal(job.status) || job.request?.media.provider !== "youtube"))
      )
        throw new Error("Задача YouTube недоступна.");
      const result = await chrome.tabs.sendMessage(
        job.tabId,
        {
          action: "youtube-media-request",
          operation: msg.operation,
          videoId: job.request?.media.videoId,
          jobId: job.id,
          url: msg.url,
          body: msg.body,
        },
        { frameId: job.request?.media.frameId || 0 },
      );
      if (!result?.ok)
        throw new Error(result?.error || "Страница YouTube не ответила.");
      return result.value;
    });
  } else if (workerHost && msg.action === "prepare-urls") {
    task = ready.then(async () => {
      await configureHeaders(msg.media, msg.urls || []);
      return true;
    });
  } else if (workerHost && msg.action === "progress") {
    task = ready.then(() => {
      const job = jobs.get(msg.id);
      if (job && !terminal(job.status)) {
        applyProgress(job, msg);
      }
      persist();
      return true;
    });
  } else if (workerHost && msg.action === "save") {
    task = ready.then(async () => {
      const job = jobs.get(msg.id);
      if (
        !job ||
        terminal(job.status) ||
        !String(msg.url).startsWith(`blob:${chrome.runtime.getURL("")}`)
      )
        throw new Error("Недопустимый результат загрузки.");
      job.status = "saving";
      job.percent = null;
      persist();
      job.browserId = await chrome.downloads.download({
        url: msg.url,
        filename: safeName(job.title, msg.extension),
        saveAs: false,
        conflictAction: "uniquify",
      });
      await chrome.storage.session.set({ jobs: [...jobs.values()] });
      // Tiny downloads may complete before download() resolves and the ID is assigned.
      const [saved] = await chrome.downloads.search({ id: job.browserId });
      if (saved && ["complete", "interrupted"].includes(saved.state))
        await finishBrowserDownload(job.browserId, saved.state);
      return job.browserId;
    });
  } else if (workerHost && msg.action === "folder-saved") {
    task = ready.then(async () => {
      const job = jobs.get(msg.id);
      if (!job || terminal(job.status)) return false;
      job.status = "complete";
      job.percent = 100;
      job.outputBytes = Number(msg.bytes) || job.outputBytes;
      job.bytes = Math.max(job.bytes || 0, Number(msg.bytes) || 0);
      job.savedFilename = boundedText(msg.filename);
      job.folderName =
        job.request?.destination?.mode === "directory"
          ? job.request.destination.name
          : undefined;
      delete job.request;
      await chrome.storage.session.set({ jobs: [...jobs.values()] });
      await offscreen("release", { id: job.id });
      await clearRules();
      scheduleDrain();
      return true;
    });
  } else if (workerHost && msg.action === "ended") {
    task = ready.then(async () => {
      const job = jobs.get(msg.id);
      if (job && !terminal(job.status)) {
        job.status = msg.cancelled ? "cancelled" : "failed";
        job.error = boundedText(msg.error, 500);
        delete job.request;
        persist();
      }
      const rules = await chrome.declarativeNetRequest.getSessionRules();
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: rules.filter((r) => r.id >= 100).map((r) => r.id),
      });
      scheduleDrain();
      return true;
    });
  } else return;
  task.then(
    (value) => reply({ ok: true, value }),
    (error) => reply({ ok: false, error: error.message }),
  );
  return true;
});

async function finishBrowserDownload(id, state) {
  await ready;
  const job = [...jobs.values()].find((j) => j.browserId === id);
  if (!job || terminal(job.status)) return;
  job.status = state === "complete" ? "complete" : "failed";
  if (job.status === "failed")
    job.error = "Сохранение файла прервано браузером.";
  job.percent = job.status === "complete" ? 100 : job.percent;
  delete job.request;
  persist();
  await offscreen("release", { id: job.id }).catch(() => {});
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: rules.filter((r) => r.id >= 100).map((r) => r.id),
  });
  scheduleDrain();
}
chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state && ["complete", "interrupted"].includes(delta.state.current))
    finishBrowserDownload(delta.id, delta.state.current).catch(() => {});
});
