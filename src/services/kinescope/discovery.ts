import type { Candidate } from "../../domain/media.js";
import { httpUrl } from "../../core/media.js";
import { thumbnailUrl } from "../../core/discovery.js";
import { matchesServiceHost } from "../hostnames.js";
const record = (value: unknown): Record<string, any> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
export function kinescopeVideoId(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!matchesServiceHost(url, "kinescope")) return;
    const match = /^\/(?:embed\/)?([\w-]{3,100})\/?$/.exec(url.pathname);
    return match && match[1] !== "embed" && match[1] !== "pl"
      ? match[1]
      : undefined;
  } catch {
    return;
  }
}
const samePath = (a: string, b: string) => {
  try {
    const left = new URL(a),
      right = new URL(b);
    return left.origin === right.origin && left.pathname === right.pathname;
  } catch {
    return false;
  }
};
const protectedSource = (value: unknown) => {
  if (!value) return false;
  if (typeof value !== "object") return value !== false;
  const object = record(value);
  return object.enabled !== false && Object.keys(object).length > 0;
};
export interface KinescopeManifest {
  url: string;
  text: string;
  kind: "hls" | "dash";
}
/** Reads only the current iframe's native playerOptions; never follows download-link APIs or another playlist item. */
export function kinescopeCandidate(
  value: unknown,
  pageUrl: string,
  manifest?: KinescopeManifest,
): Candidate | undefined {
  const alias = kinescopeVideoId(pageUrl);
  if (!alias) return;
  const config = record(value),
    playlist = Array.isArray(config.playlist)
      ? config.playlist.slice(0, 20)
      : [];
  const sources = (entry: Record<string, any>) =>
    Object.entries(record(entry.sources)).flatMap(([name, raw]) => {
      if (!["hls", "shakahls", "dash", "shakadash"].includes(name)) return [];
      const source = record(raw),
        url =
          typeof source.src === "string" && source.src.length <= 12000
            ? httpUrl(source.src, pageUrl)
            : null;
      return url
        ? [
            {
              url,
              kind: name.includes("dash")
                ? ("dash" as const)
                : ("hls" as const),
              drm: protectedSource(source.drm),
            },
          ]
        : [];
    });
  let entry = playlist
    .map(record)
    .find(
      (item) =>
        String(item.id) === alias ||
        kinescopeVideoId(record(item.meta).url) === alias,
    );
  if (!entry && manifest && playlist.length === 1) {
    const only = record(playlist[0]);
    if (
      !record(only.meta).url &&
      sources(only).some((source) => samePath(source.url, manifest.url))
    )
      entry = only;
  }
  if (
    !entry ||
    entry.error ||
    entry.hasAccess === false ||
    entry.access === false ||
    entry.status === "blocked"
  )
    return;
  const available = sources(entry);
  if (!available.length) return;
  if (
    manifest &&
    !available.some(
      (source) =>
        source.kind === manifest.kind && samePath(source.url, manifest.url),
    )
  )
    return;
  const page = new URL(pageUrl),
    clipped =
      page.searchParams.has("seek") || page.searchParams.has("duration");
  if (clipped && !manifest) return;
  const primary = manifest
    ? { url: httpUrl(manifest.url), kind: manifest.kind }
    : available.find((source) => source.kind === "hls") || available[0];
  if (!primary.url) return;
  const id =
    typeof entry.id === "string" && /^[\w-]{3,100}$/.test(entry.id)
      ? entry.id
      : alias;
  const clip = clipped
    ? ":" +
      String(Number(page.searchParams.get("seek")) || 0) +
      ":" +
      String(Number(page.searchParams.get("duration")) || 0)
    : "";
  const poster =
    typeof entry.poster === "string"
      ? entry.poster
      : record(record(entry.poster).src).src || record(entry.poster).src;
  const duration = Number(record(entry.meta).duration);
  return {
    url: primary.url,
    kind: primary.kind,
    provider: "kinescope",
    videoId: id,
    groupId: "kinescope:" + id + clip,
    source: "Kinescope",
    sourceUrls: clipped
      ? [primary.url]
      : [...new Set([primary.url, ...available.map((source) => source.url)])],
    title:
      typeof entry.title === "string" ? entry.title.slice(0, 300) : undefined,
    thumbnail: thumbnailUrl(poster, pageUrl) || undefined,
    duration:
      !clipped && Number.isFinite(duration) && duration > 0
        ? duration
        : undefined,
    manifestText: manifest?.text,
    drm: protectedSource(entry.drm) || available.some((source) => source.drm),
  };
}
