import { httpUrl } from "../../core/media.js";
export const youtubeId = (value) =>
  typeof value === "string" && /^[\w-]{11}$/.test(value) ? value : null;
export function youtubePageId(value) {
  try {
    const url = new URL(value);
    return youtubeId(
      url.searchParams.get("v") ||
        /^\/(?:shorts|embed|live)\/([\w-]{11})/.exec(url.pathname)?.[1],
    );
  } catch {
    return null;
  }
}
const container = (mime) =>
  String(mime || "")
    .split(";")[0]
    .split("/")[1];
const codecScore = (mime) =>
  /avc1/i.test(mime) ? 3 : /vp0?9/i.test(mime) ? 2 : /av01/i.test(mime) ? 1 : 0;
const playableUrl = (format) => {
  const url = httpUrl(format.url);
  if (!url || format.drmFamilies?.length) return null;
  // These need player-specific deciphering. Never advertise unresolved signatures as downloads.
  if (
    !format.nativeValidated &&
    (format.signatureCipher ||
      format.cipher ||
      new URL(url).searchParams.has("n"))
  )
    return null;
  return url;
};

export function youtubeEntries(response, observed = []) {
  const streams = response.streamingData || {};
  const attach = (format) => {
    const native = observed.find(
      (o) =>
        String(o.itag) === String(format.itag) &&
        (!format.lastModified ||
          String(o.lastModified) === String(format.lastModified)),
    );
    return native
      ? {
          ...format,
          url: native.url,
          nativeValidated: true,
          signatureCipher: undefined,
          cipher: undefined,
        }
      : format;
  };
  const audio = (streams.adaptiveFormats || [])
    .map(attach)
    .filter((f) => /^audio\//.test(f.mimeType || "") && playableUrl(f));
  const all = [
      ...(streams.formats || []),
      ...(streams.adaptiveFormats || []),
    ].map(attach),
    entries = [];
  for (const format of all) {
    if (!/^video\//.test(format.mimeType || "")) continue;
    const url = playableUrl(format);
    if (!url) continue;
    const muxed = Boolean(
      format.audioQuality || format.audioSampleRate || format.audioChannels,
    );
    const matches = audio
      .filter((a) => container(a.mimeType) === container(format.mimeType))
      .sort(
        (a, b) =>
          Number(b.audioTrack?.audioIsDefault || false) -
            Number(a.audioTrack?.audioIsDefault || false) ||
          (b.averageBitrate || b.bitrate || 0) -
            (a.averageBitrate || a.bitrate || 0),
      );
    if (!muxed && !matches.length) continue;
    const height = Number(format.height) || parseInt(format.qualityLabel) || 0,
      fps = Number(format.fps) || 0;
    const codec = /avc1/i.test(format.mimeType)
      ? "H.264"
      : /vp0?9/i.test(format.mimeType)
        ? "VP9"
        : /av01/i.test(format.mimeType)
          ? "AV1"
          : "";
    entries.push({
      url,
      audioUrl: muxed ? undefined : playableUrl(matches[0]),
      kind: muxed ? "file" : "pair",
      height,
      fps,
      mime: format.mimeType,
      formatId: String(format.itag),
      label: `${height ? height + "p" : format.qualityLabel || "Видео"}${fps > 30 ? " " + fps + " fps" : ""}${codec ? " · " + codec : ""}`,
      bitrate: Number(format.averageBitrate || format.bitrate) || 0,
    });
  }
  entries.sort(
    (a, b) =>
      b.height - a.height ||
      b.fps - a.fps ||
      codecScore(b.mime) - codecScore(a.mime) ||
      b.bitrate - a.bitrate,
  );
  const seen = new Set();
  return entries.filter((e) => {
    const key = e.height + ":" + e.fps;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function sabrEntries(response, videoId) {
  if (
    !response.danSabrReady ||
    !response.streamingData?.serverAbrStreamingUrl ||
    response.videoDetails?.isLiveContent
  )
    return [];
  const formats = response.streamingData.adaptiveFormats || [],
    page = "https://www.youtube.com/watch?v=" + videoId;
  const metadata = (f) =>
    Object.fromEntries(
      Object.entries(f).filter(
        ([k]) => !["url", "signatureCipher", "cipher"].includes(k),
      ),
    );
  const placeholders = formats.map((f) => ({
    ...f,
    url: page + "&itag=" + f.itag,
    signatureCipher: undefined,
    cipher: undefined,
  }));
  return youtubeEntries({ streamingData: { adaptiveFormats: placeholders } })
    .filter((e) => e.audioUrl)
    .map((e) => ({
      ...e,
      url: page,
      kind: "sabr",
      audioUrl: undefined,
      sabrVideo: metadata(formats.find((f) => String(f.itag) === e.formatId)),
      sabrAudio: metadata(
        formats.find(
          (f) =>
            String(f.itag) === new URL(e.audioUrl).searchParams.get("itag"),
        ),
      ),
    }));
}
export async function resolveYouTube(
  videoId,
  {
    readPlayer,
    observed = [],
  }: {
    readPlayer?: (id: string) => Promise<Record<string, any>>;
    observed?: { itag?: string; lastModified?: string; url: string }[];
  } = {},
) {
  if (!youtubeId(videoId)) throw new Error("Некорректный ID видео YouTube.");
  if (typeof readPlayer !== "function")
    throw new Error("Откройте видео в обычном плеере YouTube.");
  const data = await readPlayer(videoId),
    status = data.playabilityStatus;
  if (status?.status !== "OK")
    throw new Error(
      "YouTube: " +
        (status?.reason ||
          "видео недоступно без дополнительного подтверждения доступа."),
    );
  const direct = youtubeEntries(data, observed),
    entries = direct.length ? direct : sabrEntries(data, videoId),
    qualities = [];
  const heights = new Set();
  for (const f of [
    ...(data.streamingData?.formats || []),
    ...(data.streamingData?.adaptiveFormats || []),
  ].sort((a, b) => (b.height || 0) - (a.height || 0))) {
    if (f.height && !heights.has(f.height)) {
      heights.add(f.height);
      qualities.push({ label: f.height + "p" });
    }
  }
  const unavailableReason = entries.length
    ? undefined
    : data.streamingData?.serverAbrStreamingUrl
      ? "YouTube использует SABR. Запустите воспроизведение на странице, чтобы загрузчик получил действующую сессию, затем обновите ссылки."
      : "Запустите воспроизведение в обычном плеере YouTube и обновите качества. Пока нет проверенных ссылок на целые дорожки.";
  return {
    entries,
    qualities,
    unavailableReason,
    title: data.videoDetails?.title,
    duration: Number(data.videoDetails?.lengthSeconds) || undefined,
    thumbnail: data.videoDetails?.thumbnail?.thumbnails?.at(-1)?.url,
    resolvedAt: Date.now(),
  };
}
export function nativeYouTubeUrl(value) {
  try {
    const url = new URL(value);
    if (
      !url.hostname.endsWith(".googlevideo.com") ||
      url.searchParams.has("ump")
    )
      return null;
    const signed = new Set(
      (
        (url.searchParams.get("sparams") || "") +
        "," +
        (url.searchParams.get("lsparams") || "")
      ).split(","),
    );
    for (const key of ["range", "rn", "rbuf"])
      if (!signed.has(key)) url.searchParams.delete(key);
    return {
      url: url.href,
      itag: url.searchParams.get("itag"),
      lastModified: url.searchParams.get("lmt"),
    };
  } catch {
    return null;
  }
}

export async function probeYouTubeEntry(entry, { fetcher = fetch } = {}) {
  if (entry?.kind === "sabr") return;
  for (const url of [entry?.url, entry?.audioUrl].filter(Boolean)) {
    const response = await fetcher(url, {
      headers: { Range: "bytes=0-1023" },
      credentials: "include",
      signal: AbortSignal.timeout(15000),
    });
    await response.body?.cancel().catch(() => {});
    if (!response.ok) {
      const error = new Error(
        `YouTube: HTTP ${response.status}. Источник отклонил ссылку на поток.`,
      );
      Object.assign(error, { status: response.status });
      throw error;
    }
  }
}
