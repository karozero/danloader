import type { Media, Variant, QualityResult } from "../../domain/media.js";
import type { ServiceContext } from "../contracts.js";
import { parseHls } from "../../core/hls.js";
import { parseDash } from "../../core/dash.js";
export async function inspectCommon(
  media: Media,
  context: ServiceContext,
  { uniqueQualities = false } = {},
): Promise<QualityResult> {
  const { signal } = context;
  signal?.throwIfAborted();
  if (media.drm) throw new Error("Видео защищено DRM и не поддерживается.");
  let result: QualityResult;
  if (media.entries?.length) {
    const variants: Variant[] = media.entries.map((e) => ({
      ...e,
      label: e.label || e.kind.toUpperCase(),
    }));
    result = {
      variants,
      duration: media.duration,
      live: false,
      drm: media.drm,
      urls: media.entries.map((e) => e.url),
    };
  } else if (media.kind === "hls") {
    const text = await context.loadManifest(
      media.url,
      media.manifestText,
      signal,
    );
    const parsed = parseHls(text, media.url);
    result = {
      ...parsed,
      variants: parsed.variants.length
        ? parsed.variants
        : [
            {
              label: media.quality || "Исходное качество",
              url: media.url,
              manifestText: media.manifestText,
            },
          ],
    };
  } else if (media.kind === "dash") {
    const text = await context.loadManifest(
      media.url,
      media.manifestText,
      signal,
    );
    result = parseDash(text, media.url, {
      uniqueQualities,
    });
    if (result.live)
      throw new Error(
        "Запись динамического DASH пока не поддерживается. HLS-трансляции доступны.",
      );
    if (!result.variants.length)
      throw new Error("В DASH-манифесте нет доступной видеодорожки.");
  } else
    result = {
      variants: [
        {
          label: media.quality || "Исходное качество",
          url: media.url,
          audioUrl: media.audioUrl,
        },
      ],
      duration: media.duration,
      live: false,
      drm: media.drm,
    };
  if (!result.variants?.length)
    throw new Error("В источнике не найдены доступные качества.");
  if (result.drm) throw new Error("Видео защищено DRM и не поддерживается.");
  return result;
}
