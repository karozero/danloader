import { staticDashTracks } from "./dash-tracks.js";
import { instagramQualities } from "../services/instagram/qualities.js";
import { httpUrl } from "./media.js";
const children = (element: Element, name: string) =>
  [...element.children].filter((e) => e.localName === name);
const first = (element, name) => children(element, name)[0];

export function parseDash(
  text: string,
  url: string,
  { uniqueQualities = false } = {},
) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  const root = doc.documentElement;
  if (root.localName !== "MPD" || doc.querySelector("parsererror"))
    throw new Error("Ответ не является DASH-манифестом.");
  const periods = children(root, "Period");
  if (periods.length !== 1)
    throw new Error("DASH с несколькими периодами пока не поддерживается.");
  const drm =
    [...root.getElementsByTagNameNS("*", "ContentProtection")].length > 0;
  const reps = [],
    urls = new Set([url]);
  function visit(node, base) {
    const baseNode = first(node, "BaseURL");
    const resolved = baseNode
      ? httpUrl(baseNode.textContent.trim(), base)
      : base;
    if (!resolved) throw new Error("Недопустимый адрес DASH.");
    if (baseNode) {
      baseNode.textContent = resolved;
      urls.add(resolved);
    }
    for (const child of node.children)
      if (child.localName !== "BaseURL") visit(child, resolved);
  }
  // A local projection needs an absolute base, including for SegmentTemplate.
  if (!first(root, "BaseURL")) {
    const base = doc.createElementNS(root.namespaceURI, "BaseURL");
    base.textContent = new URL(".", url).href;
    root.insertBefore(base, root.firstChild);
  }
  visit(root, url);
  for (const adaptation of children(periods[0], "AdaptationSet")) {
    for (const rep of children(adaptation, "Representation")) {
      const mime =
        rep.getAttribute("mimeType") ||
        adaptation.getAttribute("mimeType") ||
        "";
      const content =
        adaptation.getAttribute("contentType") || mime.split("/")[0];
      const height = Number(
        rep.getAttribute("height") || adaptation.getAttribute("height"),
      );
      const width = Number(
          rep.getAttribute("width") || adaptation.getAttribute("width"),
        ),
        fps =
          rep.getAttribute("frameRate") ||
          adaptation.getAttribute("frameRate") ||
          0,
        codecs =
          rep.getAttribute("codecs") || adaptation.getAttribute("codecs") || "";
      if (content === "video" || height)
        reps.push({
          node: rep,
          height,
          width,
          fps,
          codecs,
          mime,
          bandwidth: Number(rep.getAttribute("bandwidth")),
          label: height ? `${height}p` : rep.getAttribute("id") || "Видео",
        });
    }
  }
  reps.sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
  const choices = uniqueQualities ? instagramQualities(reps) : reps;
  const variants = choices.map((rep) => {
    const cloned = doc.cloneNode(true) as Document;
    const all = [...root.getElementsByTagNameNS("*", "Representation")];
    const clonedAll = [
      ...cloned.documentElement.getElementsByTagNameNS("*", "Representation"),
    ];
    for (const other of reps)
      if (other.node !== rep.node) clonedAll[all.indexOf(other.node)].remove();
    // Retain one default audio representation and remove subtitle adaptations.
    for (const a of [...cloned.getElementsByTagNameNS("*", "AdaptationSet")]) {
      const rs = children(a, "Representation");
      const type =
        a.getAttribute("contentType") ||
        a.getAttribute("mimeType") ||
        rs[0]?.getAttribute("mimeType") ||
        "";
      if (/^(text|application)/.test(type) || !rs.length) a.remove();
      else if (/^audio/.test(type)) rs.slice(1).forEach((r) => r.remove());
    }
    return {
      label: rep.label,
      height: rep.height,
      width: rep.width,
      fps: rep.fps,
      qualityHeight: rep.qualityHeight,
      bandwidth: rep.bandwidth,
      tracks: staticDashTracks(cloned, url),
      manifestText: new XMLSerializer().serializeToString(cloned),
    };
  });
  const durationMatch =
    /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(
      root.getAttribute("mediaPresentationDuration") ||
        periods[0].getAttribute("duration") ||
        "",
    );
  const duration = durationMatch
    ? Number(durationMatch[1] || 0) * 3600 +
      Number(durationMatch[2] || 0) * 60 +
      Number(durationMatch[3] || 0)
    : null;
  const hasAudio = [
    ...root.getElementsByTagNameNS("*", "AdaptationSet"),
    ...root.getElementsByTagNameNS("*", "Representation"),
  ].some((n) =>
    /audio/.test(
      n.getAttribute("contentType") || n.getAttribute("mimeType") || "",
    ),
  );
  return {
    variants,
    drm,
    duration,
    hasAudio,
    live: root.getAttribute("type") === "dynamic",
    urls: [...urls],
  };
}
