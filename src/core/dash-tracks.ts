import type { StaticTracks } from "../domain/media.js";
import { httpUrl, hasMetaByteRange } from "./media.js";
const children = (node: Element, name: string) =>
  [...node.children].filter((n) => n.localName === name);
const first = (node, name) => children(node, name)[0];
// Only explicit static sources are optimized. Templates and range pieces retain the general parser.
export function staticDashTracks(
  document: Document,
  url: string,
): StaticTracks | undefined {
  const root = document.documentElement;
  if (
    root.getAttribute("type") === "dynamic" ||
    root.getElementsByTagNameNS("*", "ContentProtection").length
  )
    return;
  const tracks: Partial<StaticTracks> = {};
  for (const adaptation of root.getElementsByTagNameNS("*", "AdaptationSet")) {
    const rep = first(adaptation, "Representation");
    if (!rep) continue;
    const type =
      adaptation.getAttribute("contentType") ||
      (
        rep.getAttribute("mimeType") ||
        adaptation.getAttribute("mimeType") ||
        ""
      ).split("/")[0];
    if (
      !["video", "audio"].includes(type) ||
      tracks[type as keyof StaticTracks]
    )
      continue;
    const chain = [];
    for (let node = rep; node?.localName; node = node.parentElement)
      chain.unshift(node);
    if (chain.some((node) => first(node, "SegmentTemplate"))) return;
    let base = url,
      explicit = false;
    for (const node of chain) {
      const child = first(node, "BaseURL");
      if (child) {
        base = httpUrl(child.textContent.trim(), base);
        if (!base) return;
        if (node !== root || !new URL(base).pathname.endsWith("/"))
          explicit = true;
      }
    }
    const list = chain
      .map((node) => first(node, "SegmentList"))
      .filter(Boolean)
      .at(-1);
    let pieces;
    if (list) {
      const init = first(list, "Initialization"),
        segments = children(list, "SegmentURL");
      if (
        init?.hasAttribute("range") ||
        segments.some((node) => node.hasAttribute("mediaRange"))
      )
        return;
      pieces = [
        ...(init ? [init.getAttribute("sourceURL")] : []),
        ...segments.map((node) => node.getAttribute("media")),
      ].map((value) => value && httpUrl(value, base));
    } else if (explicit) pieces = [base];
    else return;
    if (
      !pieces.length ||
      pieces.some((value) => !value || hasMetaByteRange(value))
    )
      return;
    tracks[type] = pieces;
  }
  return tracks.video && tracks.audio ? (tracks as StaticTracks) : undefined;
}
