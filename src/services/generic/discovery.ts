import type { Candidate, Variant } from "../../domain/media.js";
import { httpUrl, mediaKind } from "../../core/media.js";
import { segmentUrl, thumbnailUrl } from "../../core/discovery.js";
import { knownServiceId } from "../hostnames.js";
const identityPrefix = "dom:" + Date.now().toString(36);
let identitySequence = 0;
const identities = new WeakMap<
  HTMLVideoElement,
  { signature: string; id: string }
>();
function videoUrl(value: string, base: string): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const url = httpUrl(value, base);
  return url && !segmentUrl(url) ? url : null;
}
function sourceKind(url: string, mime = ""): "file" | "hls" | "dash" {
  const kind = mediaKind(url, mime);
  return kind === "hls" || kind === "dash" ? kind : "file";
}
function duration(value: unknown): number | undefined {
  if (typeof value === "number")
    return Number.isFinite(value) && value > 0 ? value : undefined;
  if (typeof value !== "string") return;
  const match =
    /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(
      value,
    );
  return match
    ? (+match[1] || 0) * 3600 + (+match[2] || 0) * 60 + (+match[3] || 0) ||
        undefined
    : undefined;
}
function roots(document: Document): (Document | ShadowRoot)[] {
  const result: (Document | ShadowRoot)[] = [document];
  let budget = 10000;
  for (
    let index = 0;
    index < result.length && result.length < 64 && budget > 0;
    index++
  ) {
    const walker = document.createTreeWalker(
      result[index],
      NodeFilter.SHOW_ELEMENT,
    );
    let node: Node | null;
    while ((node = walker.nextNode()) && --budget > 0) {
      const shadow = (node as Element).shadowRoot;
      if (shadow && result.length < 64) result.push(shadow);
    }
  }
  return result;
}
/** Only explicit playable URLs become candidates. Blob/MediaSource streams use the network manifest observer. */
export function discoverHtmlVideos(document: Document): Candidate[] {
  const result: Candidate[] = [];
  const poster = document.querySelector<HTMLMetaElement>(
    'meta[property="og:image"],meta[name="twitter:image"]',
  )?.content;
  for (const root of roots(document))
    for (const video of root.querySelectorAll<HTMLVideoElement>("video")) {
      if (result.length >= 50) return result;
      const variants: Variant[] = [],
        seen = new Set<string>();
      const add = (value: string, mime = "", label = "") => {
        const url = videoUrl(value, document.baseURI);
        if (!url || seen.has(url) || /^audio\//i.test(mime)) return;
        seen.add(url);
        const kind = sourceKind(url, mime);
        variants.push({
          url,
          kind,
          mime,
          label: label || (kind === "file" ? "Исходное" : kind.toUpperCase()),
        });
      };
      add(
        video.currentSrc || video.src,
        video.getAttribute("type") || "",
        video.videoHeight ? video.videoHeight + "p" : "",
      );
      for (const source of video.querySelectorAll<HTMLSourceElement>(
        "source[src]",
      ))
        add(
          source.src,
          source.type,
          source.getAttribute("label") ||
            source.getAttribute("data-quality") ||
            "",
        );
      if (!variants.length) continue;
      let image = video.poster;
      let parent: Element = video;
      for (let level = 0; !image && parent && level < 8; level++) {
        image = parent.getAttribute("poster") || "";
        const node = parent.getRootNode();
        parent =
          parent.parentElement ||
          (node instanceof ShadowRoot ? node.host : null);
      }
      let groupId: string | undefined;
      if (variants.length > 1) {
        const signature = JSON.stringify(variants.map((v) => v.url).sort());
        let identity = identities.get(video);
        if (!identity || identity.signature !== signature) {
          identity = {
            signature,
            id: identityPrefix + ":" + ++identitySequence,
          };
          identities.set(video, identity);
        }
        groupId = identity.id;
      }
      result.push({
        ...variants[0],
        url: variants[0].url,
        kind: variants[0].kind,
        title: video.getAttribute("title") || document.title,
        source: "DOM",
        groupId,
        entries: variants.length > 1 ? variants : undefined,
        thumbnail: thumbnailUrl(image || poster, document.baseURI) || undefined,
        duration: duration(video.duration),
      });
    }
  if (!result.length && knownServiceId(document.URL) === "generic")
    result.push(...metadataVideos(document));
  return result;
}
function metadataVideos(document: Document): Candidate[] {
  const result: Candidate[] = [],
    seen = new Set<string>();
  const add = (
    value: unknown,
    details: {
      title?: string;
      thumbnail?: unknown;
      duration?: unknown;
      mime?: string;
    } = {},
    explicit = false,
  ) => {
    if (typeof value !== "string") return;
    const url = videoUrl(value, document.baseURI);
    if (!url || seen.has(url) || result.length >= 20) return;
    const kind = mediaKind(url, details.mime || "");
    if (!explicit && (!kind || kind === "audio")) return;
    seen.add(url);
    result.push({
      url,
      kind: sourceKind(url, details.mime),
      source: "HTML metadata",
      title: details.title || document.title,
      thumbnail: thumbnailUrl(details.thumbnail, document.baseURI) || undefined,
      duration: duration(details.duration),
      mime: details.mime,
    });
  };
  const meta = (property: string) =>
    document.querySelector<HTMLMetaElement>(
      'meta[property="' + property + '"],meta[name="' + property + '"]',
    )?.content;
  for (const key of [
    "og:video:secure_url",
    "og:video:url",
    "og:video",
    "twitter:player:stream",
  ])
    add(meta(key), {
      title: meta("og:title"),
      thumbnail: meta("og:image"),
      mime: meta("og:video:type") || meta("twitter:player:stream:content_type"),
    });
  let budget = 1500,
    bytes = 1000000;
  const walk = (node: unknown, depth = 0) => {
    if (!node || typeof node !== "object" || --budget < 0 || depth > 12) return;
    if (Array.isArray(node)) {
      for (const child of node.slice(0, 100)) walk(child, depth + 1);
      return;
    }
    const record = node as Record<string, unknown>,
      type = record["@type"];
    if (
      type === "VideoObject" ||
      (Array.isArray(type) && type.includes("VideoObject"))
    )
      add(
        record.contentUrl,
        {
          title: typeof record.name === "string" ? record.name : undefined,
          thumbnail: Array.isArray(record.thumbnailUrl)
            ? record.thumbnailUrl[0]
            : record.thumbnailUrl,
          duration: record.duration,
        },
        true,
      );
    for (const child of Object.values(record))
      if (child && typeof child === "object") walk(child, depth + 1);
  };
  for (const script of document.querySelectorAll<HTMLScriptElement>(
    'script[type="application/ld+json"]',
  )) {
    const text = script.textContent || "";
    if (text.length > bytes) continue;
    bytes -= text.length;
    try {
      walk(JSON.parse(text));
    } catch {}
  }
  return result;
}
