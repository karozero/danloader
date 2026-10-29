import { kinescopeCandidate } from "./services/kinescope/discovery.js";
// Page-world values are untrusted candidates only. This bridge cannot start a download.
(() => {
  const observed = new Map();
  const kinescopePage = () => /(?:^|\.)kinescope\.io$/.test(location.hostname);
  function rememberKinescope(manifest?) {
    const candidate = kinescopeCandidate(
      window.playerOptions,
      location.href,
      manifest,
    );
    if (candidate) {
      const previous = observed.get(candidate.groupId);
      if (!manifest && previous?.manifestText) {
        candidate.url = previous.url;
        candidate.kind = previous.kind;
        candidate.manifestText = previous.manifestText;
      }
      observed.set(candidate.groupId, candidate);
      emit([candidate]);
      return true;
    }
    return false;
  }
  let observedRoute = location.href;
  const youtubePage = () => /(?:^|\.)youtube\.com$/.test(location.hostname);
  const metaPage = () =>
    /(?:^|\.)(?:instagram\.com|facebook\.com)$/.test(location.hostname);
  let metaBootstrapRoute = "";
  function syncRoute() {
    if (location.href !== observedRoute) {
      if (!metaPage()) observed.clear();
      observedRoute = location.href;
    }
  }
  const emit = (media) =>
    window.postMessage(
      { channel: "dan-video-candidates", media: media.slice(0, 50) },
      location.origin,
    );
  const networkUrl = (value) => {
    if (typeof value !== "string" || !value.trim()) return null;
    try {
      const url = new URL(value, location.href);
      return /^https?:$/.test(url.protocol) ? url.href : null;
    } catch {
      return null;
    }
  };
  const image = (value) => {
    const src = typeof value === "string" ? value : value?.url;
    if (
      typeof src === "string" &&
      src.length <= 220000 &&
      /^data:image\/(?:png|jpeg|webp);base64,[a-z\d+/=]+$/i.test(src)
    )
      return src;
    return networkUrl(src);
  };

  function rememberVideo(video) {
    if (!video || typeof video !== "object") return;
    const entries = [],
      quality = {
        tiny: "144p",
        lowest: "240p",
        low: "360p",
        medium: "480p",
        high: "720p",
        full_hd: "1080p",
        quad_hd: "1440p",
        ultra_hd: "2160p",
      };
    for (const item of video.playerUrls || []) {
      const url = networkUrl(item?.url);
      if (!url) continue;
      const type = String(item.type || "");
      if (type.includes("dash"))
        entries.push({ url, kind: "dash", label: "DASH · все качества" });
      else if (type.includes("hls"))
        entries.push({ url, kind: "hls", label: "HLS · все качества" });
      else if (quality[type])
        entries.push({ url, kind: "file", label: quality[type] });
    }
    if (video.sources) {
      for (const [label, value] of Object.entries(video.sources.MPEG || {})) {
        const url = networkUrl(value);
        if (url) entries.push({ url, kind: "file", label });
      }
      for (const [key, value] of Object.entries(video.sources))
        if (key !== "MPEG") {
          const url = networkUrl((value as { url?: string })?.url);
          if (url && /^(HLS|DASH)/.test(key))
            entries.push({
              url,
              kind: key.startsWith("HLS") ? "hls" : "dash",
              label: key.startsWith("HLS")
                ? "HLS · все качества"
                : "DASH · все качества",
            });
        }
    }
    if (!entries.length) return;
    // One explicit player ID owns all its qualities, manifests and subsequent network fragments.
    entries
      .sort(
        (a, b) =>
          (a.kind === "file" ? 10000 : 0) +
          (parseInt(a.label) || 0) -
          ((b.kind === "file" ? 10000 : 0) + (parseInt(b.label) || 0)),
      )
      .reverse();
    const id = String(
      video.unitedVideoId ||
        video.vid ||
        video.videoId ||
        video.id ||
        entries[0].url,
    );
    const primary = entries[0];
    const candidate = {
      ...primary,
      entries,
      groupId: "boosty:" + id,
      title: video.title || document.title,
      duration: Number(video.duration) || undefined,
      thumbnail: image(video.thumbUrl || video.preview || video.defaultPreview),
      source: "Boosty player",
    };
    observed.set(id, candidate);
    while (observed.size > 20) observed.delete(observed.keys().next().value);
    emit([candidate]);
  }
  function readBoosty(value) {
    let budget = 6000;
    const walk = (node, depth = 0) => {
      if (
        !node ||
        typeof node !== "object" ||
        depth > 18 ||
        --budget < 0 ||
        node.hasAccess === false
      )
        return;
      if (Array.isArray(node.playerUrls)) rememberVideo(node);
      if (Array.isArray(node)) {
        for (const child of node.slice(0, 200)) walk(child, depth + 1);
      } else for (const child of Object.values(node)) walk(child, depth + 1);
    };
    walk(value);
  }
  const socialCode = () =>
    /\/(?:reels?|p|tv)\/([^/?]+)/.exec(new URL(location.href).pathname)?.[1];
  const shortcodeId = (code) => {
    if (!/^[A-Za-z0-9_-]{1,11}$/.test(code || "")) return undefined;
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let value = 0n;
    for (const char of code)
      value = value * 64n + BigInt(alphabet.indexOf(char));
    return String(value);
  };
  const mediaId = (value) =>
    typeof value === "string" ||
    (typeof value === "number" && Number.isSafeInteger(value))
      ? String(value).replace(/^(\d+)_\d+$/, "$1")
      : undefined;
  function markSocialCurrent() {
    const candidates = [...observed.values()].filter(
      (m) => m.provider === "instagram",
    );
    const clean = (value) => {
      try {
        const url = new URL(value);
        url.searchParams.delete("bytestart");
        url.searchParams.delete("byteend");
        return url.href;
      } catch {
        return "";
      }
    };
    const playing = [...document.querySelectorAll("video")]
      .filter((video) => video.paused === false)
      .map((video) => ({ video, rect: video.getBoundingClientRect?.() }))
      .filter(
        ({ rect }) =>
          !rect ||
          (rect.width > 0 &&
            rect.height > 0 &&
            rect.bottom > 0 &&
            rect.top < (window.innerHeight || 10000)),
      );
    playing.sort(
      (a, b) =>
        (b.rect
          ? Math.min(b.rect.bottom, window.innerHeight || 10000) -
            Math.max(0, b.rect.top)
          : 0) -
        (a.rect
          ? Math.min(a.rect.bottom, window.innerHeight || 10000) -
            Math.max(0, a.rect.top)
          : 0),
    );
    let active;
    for (const { video } of playing) {
      const src = networkUrl(video.currentSrc || video.src);
      if (src) {
        active = candidates.find((m) =>
          m.entries?.some((e) => clean(e.url) === clean(src)),
        );
        if (active) break;
      }
    }
    const target = socialCode(),
      changed = [];
    for (const item of candidates) {
      const current = active
        ? item.groupId === active.groupId
        : Boolean(target && item.reelCode === target);
      if (item.isCurrent !== current) {
        item.isCurrent = current;
        changed.push(item);
      }
    }
    return changed;
  }
  function readSocial(value) {
    syncRoute();
    let budget = 12000;
    const walk = (
      node,
      parent: {
        id?: string;
        code?: string;
        thumbnail?: string;
        duration?: number;
        title?: string;
      } = {},
      depth = 0,
    ) => {
      if (!node || typeof node !== "object" || depth > 30 || --budget < 0)
        return;
      if (Array.isArray(node)) {
        for (const child of node.slice(0, 250)) walk(child, parent, depth + 1);
        return;
      }
      const ownCode =
        typeof (node.shortcode || node.code) === "string" &&
        /^[\w-]{3,100}$/.test(node.shortcode || node.code)
          ? node.shortcode || node.code
          : undefined;
      const ownId = [node.pk, node.video_id, node.media_id, node.id]
        .map(mediaId)
        .find(Boolean);
      const versions = Array.isArray(node.video_versions)
        ? node.video_versions
        : [];
      const xml =
        node.video_dash_manifest ||
        node.dash_manifest_xml_string ||
        node.manifest_xml;
      const hasMedia =
        versions.length ||
        node.video_url ||
        node.browser_native_hd_url ||
        (typeof xml === "string" && xml.includes("<MPD"));
      const record =
        ownCode ||
        (ownId &&
          (hasMedia ||
            node.video_id ||
            node.media_id ||
            node.media_type ||
            node.video_duration ||
            node.image_versions2 ||
            node.__typename === "GraphVideo"));
      const inherited: typeof parent =
        record &&
        ((ownCode && ownCode !== parent.code) || (ownId && ownId !== parent.id))
          ? {}
          : parent;
      const info = {
        id: record ? ownId : parent.id,
        code: ownCode || inherited.code,
        thumbnail:
          image(
            node.image_versions2?.candidates?.[0]?.url ||
              node.display_url ||
              node.thumbnail_src ||
              node.display_src,
          ) || inherited.thumbnail,
        duration:
          Number(node.video_duration || node.duration) || inherited.duration,
        title:
          node.title ||
          node.caption?.text ||
          node.edge_media_to_caption?.edges?.[0]?.node?.text ||
          inherited.title,
      };
      if (hasMedia && (info.code || info.id)) {
        const known = info.id
          ? [...observed.values()].find(
              (m) =>
                m.provider === "instagram" &&
                m.instagramMediaId === info.id &&
                (!info.code || !m.reelCode || m.reelCode === info.code),
            )
          : undefined;
        info.code ||=
          known?.reelCode ||
          (info.id === shortcodeId(socialCode()) ? socialCode() : undefined);
        const entries = [],
          id = info.code || "id:" + info.id;
        const audio = networkUrl(
          node.audio_url || node.audio_versions?.[0]?.url,
        );
        for (const version of versions) {
          const url = networkUrl(version?.url);
          if (url)
            entries.push({
              url,
              kind: audio && node.has_audio === false ? "pair" : "file",
              audioUrl: audio || undefined,
              hasAudio: node.has_audio,
              width: Number(version.width) || undefined,
              height: Number(version.height) || undefined,
              bitrate: Number(version.bitrate) || undefined,
              mime: version.mime_type || version.mime || "video/mp4",
              label: version.height ? version.height + "p" : "Исходное",
              formatId: String(
                version.id || version.type || version.height || url,
              ),
            });
        }
        for (const [key, label] of [
          ["video_url", "Исходное"],
          ["browser_native_hd_url", "HD"],
          ["browser_native_sd_url", "SD"],
        ]) {
          const url = networkUrl(node[key]);
          if (url)
            entries.push({
              url,
              kind: audio && node.has_audio === false ? "pair" : "file",
              audioUrl: audio || undefined,
              hasAudio: node.has_audio,
              width:
                Number(
                  node.dimensions?.width || node.original_width || node.width,
                ) || undefined,
              height:
                Number(
                  node.dimensions?.height ||
                    node.original_height ||
                    node.height,
                ) || undefined,
              label,
              formatId: key,
            });
        }
        if (
          typeof xml === "string" &&
          xml.length <= 1000000 &&
          xml.includes("<MPD")
        ) {
          const base =
            entries[0]?.url ||
            /\bhttps?:[^<\s]+/.exec(xml)?.[0]?.replace(/&amp;/g, "&") ||
            location.href;
          const virtual = new URL(base, location.href);
          virtual.pathname = virtual.pathname.replace(
            /[^/]*$/,
            "__dan_" + encodeURIComponent(id) + ".mpd",
          );
          virtual.search = "";
          virtual.hash = "";
          entries.unshift({
            url: virtual.href,
            kind: "dash",
            manifestText: xml,
            label: "Все качества",
            formatId: "mpd",
          });
        }
        if (entries.length) {
          const groupId = "instagram:" + id,
            previous = observed.get(groupId) || known,
            unique = new Set(),
            qualities = new Set();
          const aliases =
            info.code && info.id ? ["instagram:id:" + info.id] : [];
          for (const alias of aliases)
            if (alias !== groupId) observed.delete(alias);
          const formats = [...entries, ...(previous?.entries || [])]
            .filter((e) => {
              const key = e.kind + ":" + e.url;
              if (unique.has(key)) return false;
              unique.add(key);
              return true;
            })
            .sort(
              (a, b) =>
                Number(b.kind === "dash") - Number(a.kind === "dash") ||
                (parseInt(b.label) || 0) - (parseInt(a.label) || 0) ||
                (b.bitrate || 0) - (a.bitrate || 0),
            )
            .filter((e) => {
              if (!["file", "pair"].includes(e.kind)) return true;
              const key =
                e.kind +
                ":" +
                (e.width && e.height
                  ? Math.min(e.width, e.height)
                  : e.height || e.label) +
                ":" +
                (e.fps || 0);
              if (qualities.has(key)) return false;
              qualities.add(key);
              return true;
            });
          const primary = formats[0],
            candidate = {
              ...primary,
              groupId,
              aliasGroupIds: aliases,
              instagramMediaId: info.id || previous?.instagramMediaId,
              reelCode: info.code,
              provider: "instagram",
              entries: formats,
              title: String(
                info.title ||
                  previous?.title ||
                  "Reel " + (info.code || info.id),
              ).slice(0, 300),
              duration: info.duration || previous?.duration,
              thumbnail: info.thumbnail || previous?.thumbnail,
              hasAudio:
                typeof node.has_audio === "boolean"
                  ? node.has_audio
                  : previous?.hasAudio,
              source: "Instagram",
            };
          observed.set(groupId, candidate);
          const changed = markSocialCurrent();
          emit([...new Set([candidate, ...changed])]);
        }
      }
      for (const [key, child] of Object.entries(node))
        walk(
          child,
          (Array.isArray(child) &&
            !["dash_manifests", "video_versions", "audio_versions"].includes(
              key,
            )) ||
            ["user", "owner", "author"].includes(key)
            ? {}
            : info,
          depth + 1,
        );
    };
    walk(value);
    while (observed.size > 40) {
      const key = [...observed].find(([, item]) => !item.isCurrent)?.[0];
      if (!key) break;
      observed.delete(key);
    }
  }
  function socialJson(text) {
    const clean = text
      .replace(/^\s*for\s*\(\s*;;\s*\)\s*;\s*/, "")
      .replace(/^\s*\)\]\}',?\s*/, "");
    try {
      readSocial(JSON.parse(clean));
    } catch {
      for (const line of clean.split("\n").slice(0, 50))
        try {
          readSocial(JSON.parse(line));
        } catch {}
    }
  }
  function socialHtml(text) {
    for (const match of text.matchAll(
      /<script\b[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi,
    ))
      socialJson(match[1]);
  }
  async function bootstrapSocial() {
    if (!metaPage() || metaBootstrapRoute === location.href) return;
    const page = location.href;
    metaBootstrapRoute = page;
    try {
      const response = await originalFetch(page, {
        credentials: "same-origin",
      });
      if (
        !response.ok ||
        page !== location.href ||
        /\/accounts\/login/.test(response.url)
      )
        return;
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      let text = "",
        bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (bytes > 4000000) return;
          text += decoder.decode(value, { stream: true });
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      if (page === location.href) socialHtml(text + decoder.decode());
    } catch {}
  }
  async function youtubePlayerRequest(message) {
    const reply = (value) =>
      window.postMessage(
        { channel: "dan-video-youtube-result", uid: message.uid, ...value },
        location.origin,
      );
    try {
      const page = new URL(location.href),
        currentId =
          page.searchParams.get("v") ||
          /^\/(?:shorts|embed|live)\/([\w-]{11})/.exec(page.pathname)?.[1];
      if (!youtubePage() || message.videoId !== currentId)
        throw new Error(
          "Откройте исходное видео YouTube, чтобы обновить ссылки на потоки.",
        );
      const data =
        document.getElementById?.("movie_player")?.getPlayerResponse?.() ||
        window.ytInitialPlayerResponse;
      if (!data || data.videoDetails?.videoId !== currentId)
        throw new Error(
          "Обычный плеер YouTube ещё не предоставил данные этого видео.",
        );
      const json = JSON.stringify({
        ...data,
        danSabrReady: window.DanVideoSession?.ready() === true,
      });
      if (json.length > 1000000)
        throw new Error("Ответ YouTube слишком большой.");
      reply({ status: 200, json });
    } catch (error) {
      reply({ error: error.message });
    }
  }
  // Observe the same data the authorized page receives; no access checks or APIs are bypassed.
  const patchPlayer = (ctor) => {
    if (!ctor?.prototype?.initPlayer || ctor.prototype.initPlayer.__danObserved)
      return;
    const original = ctor.prototype.initPlayer;
    function init(config, ...rest) {
      try {
        for (const video of config?.videos || []) rememberVideo(video);
      } catch {}
      return Reflect.apply(original, this, [config, ...rest]);
    }
    init.__danObserved = true;
    ctor.prototype.initPlayer = init;
  };
  patchPlayer(customElements.get("vk-video-player"));
  customElements
    .whenDefined("vk-video-player")
    .then(() => patchPlayer(customElements.get("vk-video-player")));
  if (
    location.hostname === "boosty.to" ||
    location.hostname.endsWith(".boosty.to")
  ) {
    const define = customElements.define;
    customElements.define = function (name, ctor, options) {
      if (name === "vk-video-player") patchPlayer(ctor);
      return Reflect.apply(define, this, [name, ctor, options]);
    };
  }

  function observeText(text, url, type = "") {
    if (
      typeof text !== "string" ||
      text.length > (metaPage() ? 4000000 : 1000000)
    )
      return;
    if (metaPage() && /json/i.test(type)) {
      socialJson(text);
      return;
    }
    if (
      kinescopePage() &&
      (text.trimStart().startsWith("#EXTM3U") || /<(?:\w+:)?MPD\b/.test(text))
    ) {
      if (
        rememberKinescope({
          url,
          text,
          kind: text.trimStart().startsWith("#EXTM3U") ? "hls" : "dash",
        })
      )
        return;
    }
    if (text.trimStart().startsWith("#EXTM3U"))
      emit([
        {
          url,
          kind: "hls",
          manifestText: text,
          title: document.title,
          source: "page manifest",
        },
      ]);
    else if (/<(?:\w+:)?MPD\b/.test(text))
      emit([
        {
          url,
          kind: "dash",
          manifestText: text,
          title: document.title,
          source: "page manifest",
        },
      ]);
    else if (
      (location.hostname === "boosty.to" ||
        location.hostname.endsWith(".boosty.to")) &&
      /json/i.test(type)
    )
      try {
        readBoosty(JSON.parse(text));
      } catch {}
    else if (metaPage() && /json/i.test(type)) socialJson(text);
  }
  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const pageAtRequest = location.href;
    const promise = Reflect.apply(originalFetch, this, args);
    promise
      .then(async (response) => {
        if (pageAtRequest !== location.href && !metaPage()) return;
        const type = response.headers.get("content-type") || "";
        if (
          !/mpegurl|dash\+xml/i.test(type) &&
          !/\.m3u8|\.mpd(?:\?|$)|\/api\/playlist\/master\//i.test(
            response.url,
          ) &&
          !(
            (location.hostname === "boosty.to" || metaPage()) &&
            /json/.test(type)
          )
        )
          return;
        const limit = metaPage() && /json/.test(type) ? 4000000 : 1000000;
        if (Number(response.headers.get("content-length")) > limit) return;
        const reader = response.clone().body?.getReader();
        if (!reader) return;
        let bytes = 0,
          text = "";
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.length;
            if (bytes > limit) return;
            text += decoder.decode(value, { stream: true });
          }
          observeText(text + decoder.decode(), response.url, type);
        } finally {
          await reader.cancel().catch(() => {});
        }
      })
      .catch(() => {});
    return promise;
  };
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (...args) {
    const pageAtRequest = location.href;
    this.addEventListener(
      "load",
      () => {
        try {
          if (pageAtRequest !== location.href) return;
          const type = this.getResponseHeader("content-type") || "";
          if (
            !/mpegurl|dash\+xml/i.test(type) &&
            !/\.m3u8|\.mpd(?:\?|$)|\/api\/playlist\/master\//i.test(
              this.responseURL,
            ) &&
            !(
              (location.hostname === "boosty.to" || metaPage()) &&
              /json/.test(type)
            )
          )
            return;
          if (this.responseType === "json") {
            if (location.hostname === "boosty.to") readBoosty(this.response);
            else if (metaPage()) readSocial(this.response);
          } else if (this.responseType === "" || this.responseType === "text")
            observeText(this.responseText, this.responseURL, type);
        } catch {}
      },
      { once: true },
    );
    return Reflect.apply(open, this, args);
  };
  function snapshot() {
    syncRoute();
    if (kinescopePage()) rememberKinescope();
    const media = metaPage() ? [] : [...observed.values()];
    const add = (url, kind = "file", extra = {}) => {
      try {
        const u = new URL(url, location.href);
        if (["http:", "https:"].includes(u.protocol))
          media.push({ url: u.href, kind, ...extra });
      } catch {}
    };
    const title = document.title;
    if (
      location.hostname === "boosty.to" ||
      location.hostname.endsWith(".boosty.to")
    )
      for (const script of document.querySelectorAll(
        'script[type="application/json"]',
      ))
        if (script.textContent.length <= 1000000)
          try {
            readBoosty(JSON.parse(script.textContent));
          } catch {}
    if (metaPage()) {
      let budget = 4000000;
      for (const script of document.querySelectorAll(
        'script[type="application/json"]',
      )) {
        const text = script.textContent || "";
        if (text.length > budget) continue;
        budget -= text.length;
        socialJson(text);
      }
      bootstrapSocial();
      markSocialCurrent();
      media.push(...observed.values());
    }
    try {
      const files = window.playerConfig?.request?.files;
      const hls = files?.hls;
      if (hls?.cdns?.[hls.default_cdn]?.url)
        add(hls.cdns[hls.default_cdn].url, "hls", { title, source: "Vimeo" });
      for (const f of files?.progressive || [])
        if (f.url)
          add(f.url, "file", { title, quality: f.quality, source: "Vimeo" });
    } catch {}
    try {
      if (youtubePage()) {
        const current = new URL(location.href),
          id =
            current.searchParams.get("v") ||
            /^\/(?:shorts|embed|live)\/([\w-]{11})/.exec(current.pathname)?.[1];
        if (id && /^[\w-]{11}$/.test(id)) {
          const player = document.getElementById?.("movie_player");
          const response =
            player?.getPlayerResponse?.() || window.ytInitialPlayerResponse;
          const same = response?.videoDetails?.videoId === id;
          const status = same ? response.playabilityStatus : null;
          const candidate = {
            url: current.href,
            kind: "youtube",
            provider: "youtube",
            videoId: id,
            groupId: "youtube:" + id,
            source: "YouTube",
            title: same ? response.videoDetails.title : document.title,
            thumbnail: same
              ? response.videoDetails.thumbnail?.thumbnails?.at(-1)?.url
              : undefined,
            duration: same
              ? Number(response.videoDetails.lengthSeconds)
              : undefined,
            accessError:
              status && status.status !== "OK"
                ? status.reason ||
                  "YouTube требует подтверждения доступа к видео."
                : "",
          };
          observed.set("youtube:" + id, candidate);
          media.push(candidate);
        }
      }
    } catch {}
    try {
      for (const node of document.querySelectorAll("[data-options]")) {
        const options = JSON.parse(node.getAttribute("data-options"));
        let metadata = options?.flashvars?.metadata;
        if (typeof metadata === "string") metadata = JSON.parse(metadata);
        for (const key of [
          "hlsManifestUrl",
          "ondemandHls",
          "hlsMasterPlaylistUrl",
        ])
          if (metadata?.[key])
            add(metadata[key], "hls", { source: "OK", title });
        if (metadata?.dashSepUrl)
          add(metadata.dashSepUrl, "dash", { source: "OK", title });
      }
    } catch {}
    try {
      const player = window.__playerdata__?.__dash?.data?.program;
      for (const v of player?.video || [])
        if (typeof v.m3u8 === "string" && v.m3u8.startsWith("#EXTM3U"))
          add(location.href, "hls", {
            manifestText: v.m3u8,
            source: "IQ",
            title,
          });
    } catch {}
    // Small bounded scans of embedded data; never evaluate script source.
    let budget = 4000000;
    for (const script of document.scripts) {
      const text = script.textContent || "";
      if (!text || text.length > 1000000 || text.length > budget) continue;
      budget -= text.length;
      for (const match of text.matchAll(
        /"(hlsManifestUrl|hls_source|playback_url|hls_ondemand|hls|video_dash_manifest|dash_manifest_xml_string|manifest_xml)"\s*:\s*("(?:[^"\\]|\\.)*")/g,
      )) {
        try {
          const value = JSON.parse(match[2]);
          if (value.length > 1000000) continue;
          if (
            /^(video_dash_manifest|dash_manifest_xml_string|manifest_xml)$/.test(
              match[1],
            ) &&
            value.includes("<MPD")
          ) {
            if (metaPage()) continue;
            else
              add(location.href, "dash", {
                manifestText: value,
                source: "embedded DASH",
                title,
              });
          } else if (/^https?:/.test(value))
            add(value, /\.mp4(?:\?|$)/i.test(value) ? "file" : "hls", {
              source: "embedded HLS",
              title,
            });
        } catch {}
      }
    }
    window.postMessage(
      { channel: "dan-video-candidates", media: media.slice(0, 50) },
      location.origin,
    );
  }
  if (metaPage() && window.history)
    for (const name of ["pushState", "replaceState"]) {
      const original = window.history[name];
      window.history[name] = function (...args) {
        const result = Reflect.apply(original, this, args);
        syncRoute();
        markSocialCurrent();
        window.postMessage(
          { channel: "dan-video-navigation" },
          location.origin,
        );
        return result;
      };
    }
  if (metaPage())
    window.addEventListener("popstate", () =>
      window.postMessage({ channel: "dan-video-navigation" }, location.origin),
    );
  let last = 0;
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    if (event.data?.channel === "dan-video-youtube-request") {
      youtubePlayerRequest(event.data);
      return;
    }
    if (
      event.data?.channel === "dan-video-scan" &&
      (event.data.force === true || Date.now() - last > 500)
    ) {
      last = Date.now();
      snapshot();
    }
  });
})();
