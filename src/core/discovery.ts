import {
  canonicalMediaUrl,
  httpUrl,
  isMetaCdn,
  hasMetaByteRange,
} from "./media.js";
import { parseHls } from "./hls.js";

export function thumbnailUrl(value: unknown, base?: string) {
  if (typeof value !== "string" || value.length > 220000) return null;
  if (/^data:image\/(?:jpeg|png|webp);base64,[a-z\d+/=]+$/i.test(value))
    return value;
  return httpUrl(value, base);
}

export function durationText(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "";
  const seconds = Math.round(value),
    h = Math.floor(seconds / 3600),
    m = Math.floor((seconds % 3600) / 60),
    s = seconds % 60;
  return h
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

const xmlText = (value) =>
  value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// References, not guessed numeric file names, establish which resources belong to a manifest.
export function manifestReferences(item) {
  const exact = new Set(),
    patterns = [];
  if (!item.manifestText) return { exact, patterns };
  if (item.kind === "hls") {
    try {
      for (const url of parseHls(item.manifestText, item.url).urls)
        if (url !== item.url) exact.add(canonicalMediaUrl(url));
    } catch {}
  } else if (item.kind === "dash") {
    const text = item.manifestText,
      bases = new Set([new URL(".", item.url).href]);
    for (const match of text.matchAll(
      /<(?:[\w-]+:)?BaseURL\b[^>]*>([^<]+)<\//gi,
    )) {
      for (const base of [...bases]) {
        const url = httpUrl(xmlText(match[1].trim()), base);
        if (url) {
          bases.add(url);
          exact.add(canonicalMediaUrl(url));
        }
      }
      if (bases.size > 50) break;
    }
    for (const match of text.matchAll(
      /\b(?:media|initialization|sourceURL)\s*=\s*["']([^"']+)["']/gi,
    )) {
      for (const base of bases) {
        const url = httpUrl(xmlText(match[1]), base);
        if (!url) continue;
        if (
          /\$(?:Number|Time|RepresentationID|Bandwidth)(?:%0?\d+d)?\$/.test(url)
        ) {
          const parts = url.split(
            /(\$(?:Number|Time|RepresentationID|Bandwidth)(?:%0?\d+d)?\$)/g,
          );
          patterns.push(
            "^" +
              parts
                .map((p) => (p.startsWith("$") ? "[^/?&]+" : escape(p)))
                .join("") +
              "$",
          );
        } else exact.add(canonicalMediaUrl(url));
        if (patterns.length > 100) break;
      }
    }
  }
  return { exact, patterns: patterns.slice(0, 100) };
}

export function segmentUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return true;
  }
  const path = url.pathname;
  return (
    /\.(?:m4s|cmfv|cmfa|ts|m2ts)$/i.test(path) ||
    /(?:^|\/)(?:init(?:ialization)?(?:[-_.][^/]*)?|(?:seg(?:ment)?|chunk|frag(?:ment)?)[-_.]?\d+(?:[-_.][^/]*)?)\.(?:mp4|webm|m4v)$/i.test(
      path,
    )
  );
}

function sameDocument(a, b) {
  if (a.frameId != null && b.frameId != null && a.frameId !== b.frameId)
    return false;
  return !a.pageUrl || !b.pageUrl || a.pageUrl === b.pageUrl;
}

export function visibleMedia(items) {
  const groups = items.filter(
    (m) =>
      m.groupId &&
      (m.entries?.length ||
        m.provider === "youtube" ||
        m.provider === "kinescope"),
  );
  const refs = items
    .filter((m) => m.kind === "hls" || m.kind === "dash")
    .map((item) => ({ item, ...manifestReferences(item) }));
  return items.filter((item) => {
    if (item.kind === "audio") return false;
    if (
      item.groupId?.startsWith("dom:") &&
      groups.some(
        (group) =>
          group !== item &&
          !group.groupId.startsWith("dom:") &&
          sameDocument(group, item) &&
          (group.entries || []).some((entry) =>
            (item.entries || []).some(
              (candidate) =>
                canonicalMediaUrl(candidate.url) ===
                canonicalMediaUrl(entry.url),
            ),
          ),
      )
    )
      return false;
    if (item.groupId) return true;
    const url = canonicalMediaUrl(item.url);
    if (hasMetaByteRange(item.url)) return false;
    if (
      groups.some(
        (g) =>
          sameDocument(g, item) &&
          (canonicalMediaUrl(g.url) === url ||
            (g.sourceUrls || []).some(
              (source) => canonicalMediaUrl(source) === url,
            ) ||
            (g.entries || []).some(
              (e) =>
                canonicalMediaUrl(e.url) === url ||
                (e.audioUrl && canonicalMediaUrl(e.audioUrl) === url),
            )),
      )
    )
      return false;
    if (
      groups.some((g) => sameDocument(g, item) && g.provider === "youtube") &&
      new URL(url).hostname.endsWith(".googlevideo.com")
    )
      return false;
    if (item.source === "network" && isMetaCdn(new URL(url).hostname))
      return false;
    if (
      refs.some(
        (r) =>
          r.item !== item &&
          sameDocument(r.item, item) &&
          (r.exact.has(url) || r.patterns.some((p) => new RegExp(p).test(url))),
      )
    )
      return false;
    if (item.kind === "hls" || item.kind === "dash") return true;
    if (item.source === "network") {
      if (segmentUrl(url)) return false;
      // Match the original's conservative filtering, while allowing small explicit page videos.
      if (item.size && item.size < 500000) return false;
      if (
        (!item.size || item.size < 20000000) &&
        items.some(
          (m) =>
            m !== item &&
            sameDocument(m, item) &&
            (m.groupId || m.kind === "hls" || m.kind === "dash"),
        )
      )
        return false;
    }
    return true;
  });
}
