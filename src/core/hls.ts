import type { Variant } from "../domain/media.js";
import { httpUrl } from "./media.js";

export function attributes(line: string) {
  const out: Record<string, string> = {};
  const input = line.slice(line.indexOf(":") + 1);
  for (const m of input.matchAll(/([\w-]+)=(?:"([^"]*)"|([^,]*))/g))
    out[m[1]] = m[2] ?? m[3];
  return out;
}

export function parseHls(text: string, url: string) {
  if (!text.trimStart().startsWith("#EXTM3U"))
    throw new Error("Ответ не является HLS-плейлистом.");
  const lines = text
    .replace(/\r/g, "")
    .split("\n")
    .map((s) => s.trim());
  const variants: Variant[] = [],
    audio = [],
    urls = new Set([url]);
  let pending = null,
    drm = false,
    duration = 0;
  for (const line of lines) {
    if (line.startsWith("#EXT-X-STREAM-INF:")) pending = attributes(line);
    else if (line.startsWith("#EXT-X-MEDIA:")) {
      const a = attributes(line);
      if (a.TYPE === "AUDIO" && a.URI)
        audio.push({ ...a, url: httpUrl(a.URI, url) });
    } else if (/^#EXT-X-(SESSION-)?KEY:/.test(line)) {
      const a = attributes(line);
      if (
        (a.METHOD && !["NONE", "AES-128"].includes(a.METHOD)) ||
        (a.KEYFORMAT && a.KEYFORMAT !== "identity")
      )
        drm = true;
    } else if (line.startsWith("#EXTINF:"))
      duration += Number.parseFloat(line.slice(8)) || 0;
    else if (line && !line.startsWith("#")) {
      const resolved = httpUrl(line, url);
      if (!resolved) throw new Error("Недопустимый адрес сегмента HLS.");
      urls.add(resolved);
      if (pending) {
        const height = Number(pending.RESOLUTION?.split("x")[1]) || 0;
        variants.push({
          url: resolved,
          height,
          bandwidth: Number(pending.BANDWIDTH) || 0,
          codecs: pending.CODECS || "",
          audioGroup: pending.AUDIO,
          label: height
            ? `${height}p`
            : `${Math.round(Number(pending.BANDWIDTH) / 1000)} кбит/с`,
        });
        pending = null;
      }
    }
    if (line.startsWith("#"))
      for (const m of line.matchAll(/URI="([^"]+)"/g)) {
        const resolved = httpUrl(m[1], url);
        if (resolved) urls.add(resolved);
      }
  }
  variants.sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
  for (const v of variants) {
    const matches = audio.filter(
      (a) => a["GROUP-ID"] === v.audioGroup && a.url,
    );
    v.audioUrl = (matches.find((a) => a.DEFAULT === "YES") || matches[0])?.url;
  }
  return {
    variants,
    drm,
    duration: variants.length ? null : duration,
    live: !variants.length && !lines.includes("#EXT-X-ENDLIST"),
    urls: [...urls],
  };
}

// This projection selects an exact variant, leaving original media/key URLs intact.
export function selectedHls(variant: Variant) {
  const lines = ["#EXTM3U"];
  if (variant.audioUrl)
    lines.push(
      `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Original",DEFAULT=YES,AUTOSELECT=YES,URI="${variant.audioUrl}"`,
    );
  lines.push(
    `#EXT-X-STREAM-INF:BANDWIDTH=${variant.bandwidth || 1000000}${variant.audioUrl ? ',AUDIO="audio"' : ""}`,
    variant.url,
  );
  return lines.join("\n") + "\n";
}
