export function httpUrl(
  value: string | URL,
  base?: string | URL,
): string | null {
  try {
    const u = new URL(value, base);
    return ["http:", "https:"].includes(u.protocol) &&
      !u.username &&
      !u.password
      ? u.href
      : null;
  } catch {
    return null;
  }
}

export function mediaKind(url: string, type = "") {
  const path = (() => {
    try {
      return new URL(url).pathname;
    } catch {
      return "";
    }
  })();
  if (/mpegurl/i.test(type) || /\.m3u8$/i.test(path)) return "hls";
  if (/dash\+xml/i.test(type) || /\.mpd$/i.test(path)) return "dash";
  if (/^audio\//i.test(type)) return "audio";
  if (/^video\//i.test(type) || /\.(mp4|webm|mov|mkv|m4v)$/i.test(path))
    return "file";
  return null;
}

export function safeName(value: unknown, extension = "mp4") {
  let stem = String(value || "video")
    .replace(/[\x00-\x1f<>:"/\\|?*]/g, "_")
    .trim()
    .replace(/[. ]+$/g, "");
  stem = stem.replace(/\.(mp4|webm|mkv|mov|m4v|m3u8|mpd)$/i, "").slice(0, 140);
  if (!stem || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem))
    stem = "video_" + stem;
  return `${stem}.${/^(mp4|webm|mkv|mov|m4v)$/.test(extension) ? extension : "mp4"}`;
}

export function canonicalMediaUrl(url: string) {
  const u = new URL(url);
  // Playback byte ranges are not the identity of a Google video stream.
  if (u.hostname.endsWith(".googlevideo.com")) {
    for (const key of ["range", "rn", "rbuf", "ump", "srfvp"])
      u.searchParams.delete(key);
  }
  if (isMetaCdn(u.hostname))
    for (const key of ["bytestart", "byteend"]) u.searchParams.delete(key);
  u.hash = "";
  return u.href;
}

export function isMetaCdn(host: string) {
  return /(?:^|\.)(?:cdninstagram\.com|fbcdn\.net)$/.test(host);
}

export function hasMetaByteRange(url: string) {
  try {
    const u = new URL(url);
    return (
      isMetaCdn(u.hostname) &&
      (u.searchParams.has("bytestart") || u.searchParams.has("byteend"))
    );
  } catch {
    return false;
  }
}

export function displayHost(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
export const terminal = (status: string) =>
  ["complete", "failed", "cancelled"].includes(status);

export function boundedText(value: unknown, max = 300) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

export function isVendorUrl(url: string) {
  try {
    const host = new URL(url).hostname;
    return (
      host === "downloadhelper.net" || host.endsWith(".downloadhelper.net")
    );
  } catch {
    return true;
  }
}

export function playbackInfo(url: string, mime = "") {
  const u = new URL(url);
  if (!u.hostname.endsWith(".googlevideo.com")) return null;
  const type = u.searchParams.get("mime") || mime;
  // Only known adaptive video itags need a separate audio track.
  const adaptive = new Set([
    133, 134, 135, 136, 137, 138, 160, 212, 242, 243, 244, 247, 248, 264, 266,
    271, 272, 278, 298, 299, 302, 303, 308, 313, 315, 330, 331, 332, 333, 334,
    335, 336, 337, 394, 395, 396, 397, 398, 399, 400, 401, 402,
  ]);
  const itag = Number(u.searchParams.get("itag"));
  return {
    group: u.searchParams.get("id") || "",
    audio: type.startsWith("audio/"),
    needsAudio: adaptive.has(itag),
    itag,
  };
}
