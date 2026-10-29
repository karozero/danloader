import { matchesServiceHost } from "../hostnames.js";
import type { Media, Variant, QualityResult } from "../../domain/media.js";
import {
  type DownloadService,
  type ServiceContext,
  type DownloadPlan,
} from "../contracts.js";
import { inspectCommon } from "../shared/inspect.js";
import { prepareCommon } from "../shared/prepare.js";
import { parseDash } from "../../core/dash.js";
import { instagramQualities } from "./qualities.js";
export async function inspectInstagram(
  media: Media,
  context: ServiceContext,
): Promise<QualityResult> {
  if (!media.entries?.length)
    return inspectCommon(media, context, { uniqueQualities: true });
  let variants: Variant[] = media.entries.map((entry) => ({
    ...entry,
    label: entry.label || entry.kind.toUpperCase(),
  }));
  const dash = media.entries.find(
    (entry) => entry.kind === "dash" && entry.manifestText,
  );
  if (dash) {
    const parsed = parseDash(dash.manifestText, dash.url, {
      uniqueQualities: true,
    });
    if (parsed.drm) throw new Error("Видео защищено DRM и не поддерживается.");
    variants = parsed.variants.map((variant, index) => ({
      ...variant,
      kind: "dash",
      url: dash.url,
      hasAudio: parsed.hasAudio,
      formatId: "dash:" + index,
    }));
  } else variants = instagramQualities(variants);
  return {
    variants,
    duration: media.duration,
    live: false,
    drm: media.drm,
    urls: media.entries.map((entry) => entry.url),
  };
}
export async function downloadInstagram(
  media: Media,
  selection: number,
  context: ServiceContext,
): Promise<DownloadPlan> {
  const plan = await prepareCommon(media, selection, context);
  if (
    plan.variant.tracks ||
    (plan.media.kind === "pair" && plan.variant.audioUrl)
  ) {
    const tracks = plan.variant.tracks || {
      video: [plan.variant.url || plan.media.url],
      audio: [plan.variant.audioUrl],
    };
    return {
      ...plan,
      media: { ...plan.media, kind: "tracks", hasAudio: true },
      variant: { ...plan.variant, tracks },
      live: false,
    };
  }
  return plan;
}
export const instagramService: DownloadService = {
  id: "instagram",
  matches: (url) => matchesServiceHost(url, "instagram"),
  inspect: inspectInstagram,
  download: downloadInstagram,
};
