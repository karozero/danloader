import { discoverHtmlVideos } from "./services/generic/discovery.js";
(() => {
  const sent = new Map();
  let timer,
    scrollTimer,
    metadataKey = "";
  const youtubePending = new Map(),
    mediaPending = new Map();
  const thumbnail = (value) =>
    typeof value === "string" &&
    value.length <= 220000 &&
    /^(https?:|data:image\/(?:jpeg|png|webp);base64,)/i.test(value)
      ? value
      : undefined;
  function deliver(media) {
    const clean = [];
    for (const m of media.slice(0, 50)) {
      if (
        !m ||
        typeof m.url !== "string" ||
        !/^https?:\/\//.test(m.url) ||
        m.url.length > 12000
      )
        continue;
      if (!["file", "hls", "dash", "pair", "youtube"].includes(m.kind))
        continue;
      if (
        m.manifestText &&
        (typeof m.manifestText !== "string" || m.manifestText.length > 1000000)
      )
        continue;
      const key =
        String(m.isCurrent) +
        "|" +
        (m.reelCode || "") +
        "|" +
        m.url +
        "|" +
        (m.groupId || "") +
        "|" +
        (m.manifestText?.length || 0) +
        "|" +
        (m.quality || "") +
        "|" +
        (m.thumbnail || "").slice(-80);
      if (sent.has(key) && Date.now() - sent.get(key) < 30000) continue;
      sent.set(key, Date.now());
      clean.push({
        url: m.url,
        kind: m.kind,
        title: String(m.title || document.title).slice(0, 300),
        quality: String(m.quality || "").slice(0, 60),
        mime: String(m.mime || "").slice(0, 100),
        audioUrl: typeof m.audioUrl === "string" ? m.audioUrl : undefined,
        manifestText: m.manifestText,
        drm: m.drm === true,
        source: String(m.source || "page").slice(0, 40),
        groupId:
          typeof m.groupId === "string" ? m.groupId.slice(0, 180) : undefined,
        entries: Array.isArray(m.entries) ? m.entries.slice(0, 30) : undefined,
        thumbnail: thumbnail(m.thumbnail),
        duration: Number(m.duration) > 0 ? Number(m.duration) : undefined,
        provider: m.provider,
        isCurrent: m.isCurrent === true,
        reelCode: m.reelCode,
        instagramMediaId: m.instagramMediaId,
        aliasGroupIds: Array.isArray(m.aliasGroupIds)
          ? m.aliasGroupIds.slice(0, 5)
          : undefined,
        videoId: m.videoId,
        sourceUrls: Array.isArray(m.sourceUrls)
          ? m.sourceUrls.slice(0, 20)
          : undefined,
        hasAudio: m.hasAudio,
        accessError: m.accessError,
      });
    }
    while (sent.size > 200) sent.delete(sent.keys().next().value);
    if (clean.length)
      chrome.runtime
        .sendMessage({ action: "discover", media: clean })
        .catch(() => {});
  }
  function scan(force = false) {
    const media = [];
    const poster =
      document.querySelector<HTMLVideoElement>("video[poster]")?.poster ||
      document.querySelector<HTMLMetaElement>(
        'meta[property="og:image"],meta[name="twitter:image"]',
      )?.content;
    const nextMeta = JSON.stringify({
      title: document.title,
      thumbnail: thumbnail(poster),
    });
    if (nextMeta !== metadataKey) {
      metadataKey = nextMeta;
      chrome.runtime
        .sendMessage({ action: "page-meta", ...JSON.parse(nextMeta) })
        .catch(() => {});
    }
    media.push(...discoverHtmlVideos(document));
    deliver(media);
    window.postMessage(
      { channel: "dan-video-scan", action: "snapshot", force: force === true },
      location.origin,
    );
  }
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    if (event.data?.channel === "dan-video-navigation") {
      sent.clear();
      scan(true);
      return;
    }
    if (event.data?.channel === "dan-video-sabr-ready") {
      sent.clear();
      scan();
      return;
    }
    if (event.data?.channel === "dan-video-youtube-media-result") {
      const pending = mediaPending.get(event.data.uid);
      if (!pending) return;
      mediaPending.delete(event.data.uid);
      clearTimeout(pending.timer);
      if (
        event.data.ok === true &&
        JSON.stringify(event.data.value).length <= 23000000
      )
        pending.reply({ ok: true, value: event.data.value });
      else
        pending.reply({ ok: false, error: event.data.error || "Ошибка SABR." });
      return;
    }
    if (event.data?.channel === "dan-video-youtube-result") {
      const pending = youtubePending.get(event.data.uid);
      if (!pending) return;
      youtubePending.delete(event.data.uid);
      clearTimeout(pending.timer);
      if (
        typeof event.data.json === "string" &&
        event.data.json.length <= 1000000
      )
        pending.reply({
          ok: true,
          value: { json: event.data.json, status: event.data.status },
        });
      else
        pending.reply({
          ok: false,
          error: event.data.error || "Не удалось получить ответ YouTube.",
        });
      return;
    }
    if (
      event.data?.channel !== "dan-video-candidates" ||
      !Array.isArray(event.data.media)
    )
      return;
    deliver(event.data.media);
  });
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (
      msg?.action === "youtube-media-request" &&
      sender.id === chrome.runtime.id
    ) {
      const uid = crypto.randomUUID(),
        timer = setTimeout(() => {
          mediaPending.delete(uid);
          reply({ ok: false, error: "Страница не ответила на запрос SABR." });
        }, 35000);
      mediaPending.set(uid, { reply, timer });
      window.postMessage(
        {
          ...msg,
          action: msg.operation,
          channel: "dan-video-youtube-media-request",
          uid,
        },
        location.origin,
      );
      return true;
    }
    if (msg?.action === "rescan") {
      sent.clear();
      setTimeout(() => scan(true), 100);
    }
    if (
      msg?.action === "youtube-player-request" &&
      sender.id === chrome.runtime.id
    ) {
      const uid = crypto.randomUUID(),
        timer = setTimeout(() => {
          youtubePending.delete(uid);
          reply({
            ok: false,
            error:
              "Страница YouTube не ответила. Откройте исходное видео и обновите страницу.",
          });
        }, 20000);
      youtubePending.set(uid, { reply, timer });
      window.postMessage(
        { channel: "dan-video-youtube-request", uid, videoId: msg.videoId },
        location.origin,
      );
      return true;
    }
  });
  document.addEventListener("loadedmetadata", () => scan(), true);
  document.addEventListener("play", () => scan(true), true);
  if (/(?:^|\.)instagram\.com$/.test(location.hostname))
    document.addEventListener(
      "scroll",
      () => {
        if (!scrollTimer)
          scrollTimer = setTimeout(() => {
            scrollTimer = null;
            scan(true);
          }, 250);
      },
      { capture: true, passive: true },
    );
  function begin() {
    new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(scan, 700);
    }).observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["src", "type", "poster"],
    });
    scan();
  }
  if (document.documentElement) begin();
  else document.addEventListener("DOMContentLoaded", begin, { once: true });
  setInterval(() => {
    if (!document.hidden) scan();
  }, 5000);
})();
