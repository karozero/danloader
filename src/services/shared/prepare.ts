import { staticHlsTrack, type HlsTrack } from "../../core/hls-static.js";
import type { Media, QualityResult } from "../../domain/media.js";
import type { DownloadPlan, ServiceContext } from "../contracts.js";
import { parseHls } from "../../core/hls.js";
/** Expand grouped qualities, then resolve an exact manifest/file through the selected service. */
export async function prepareCommon(
  initialMedia: Media,
  selection: number,
  context: ServiceContext,
): Promise<DownloadPlan> {
  const { signal } = context;
  signal?.throwIfAborted();
  let media = initialMedia;
  let result = await context.inspect(media);
  let variant = result.variants[selection];
  if (!variant) throw new Error("Выбранное качество больше не доступно.");
  if (media.entries?.length) {
    media = {
      ...media,
      id: media.id + ":" + selection,
      url: variant.url,
      kind: variant.kind || media.kind,
      entries: undefined,
      manifestText: variant.manifestText,
      audioUrl: variant.audioUrl || media.audioUrl,
      mime: variant.mime || media.mime,
      hasAudio: variant.hasAudio ?? media.hasAudio,
    };
    result = await context.inspect(media, true);
    variant = result.variants[0];
  }
  if (result.hasAudio != null) media = { ...media, hasAudio: result.hasAudio };
  signal?.throwIfAborted();
  await context.prepareUrls(
    { ...media, audioUrl: variant.audioUrl || media.audioUrl },
    variant.tracks
      ? [...variant.tracks.video, ...variant.tracks.audio]
      : result.urls || [],
  );
  let live = result.live,
    duration = result.duration || media.duration || initialMedia.duration;
  const hlsTracks: (HlsTrack | undefined)[] = [];
  if (media.kind === "hls")
    for (const url of [variant.url, variant.audioUrl].filter(Boolean)) {
      const text = await context.loadManifest(
        url,
        url === media.url ? media.manifestText : undefined,
        signal,
      );
      const info = parseHls(text, url);
      hlsTracks.push(
        staticHlsTrack(text, url, {
          allowByteRanges: context.allowHlsByteRanges,
        }),
      );
      if (info.drm) throw new Error("Выбранная дорожка защищена DRM.");
      await context.prepareUrls({ ...media, audioUrl: variant.audioUrl }, [
        ...(result.urls || []),
        ...info.urls,
      ]);
      live ||= info.live;
      duration ||= info.duration;
    }
  if (hlsTracks.length && !live && hlsTracks.every(Boolean))
    variant = { ...variant, hls: { video: hlsTracks[0], audio: hlsTracks[1] } };
  return { media, variant, live, duration };
}
