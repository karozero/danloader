import type { Variant } from "../../domain/media.js";
const number = (value: unknown) => {
  if (typeof value === "string" && value.includes("/")) {
    const [a, b] = value.split("/").map(Number);
    return b ? a / b : 0;
  }
  return Number(value) || 0;
};
export function instagramQualities<T extends Variant>(variants: T[]) {
  const prepared = variants.map((v) => {
    const width = number(v.width),
      height = number(v.height),
      resolution =
        width && height
          ? Math.min(width, height)
          : height || (/^\d+p/.test(v.label || "") ? parseInt(v.label) : 0),
      fps = number(v.fps),
      rate = fps > 30 ? Math.round(fps) : 0;
    return {
      ...v,
      width,
      height,
      fps,
      qualityHeight: resolution,
      label: resolution
        ? resolution + "p" + (rate ? " · " + rate + " fps" : "")
        : v.label || "Исходное",
    };
  });
  const codec = (v) =>
    /avc[13]|h264/i.test(v.mime || v.codecs || "")
      ? 2
      : /mp4/i.test(v.mime || "")
        ? 1
        : 0;
  prepared.sort(
    (a, b) =>
      b.qualityHeight - a.qualityHeight ||
      b.fps - a.fps ||
      codec(b) - codec(a) ||
      number(b.bandwidth || b.bitrate) - number(a.bandwidth || a.bitrate),
  );
  const seen = new Set(),
    urls = new Set();
  return prepared.filter((v) => {
    const key =
      (v.qualityHeight || v.label) + ":" + (v.fps > 30 ? Math.round(v.fps) : 0);
    if (seen.has(key) || (v.url && urls.has(v.url))) return false;
    seen.add(key);
    if (v.url) urls.add(v.url);
    return true;
  });
}
