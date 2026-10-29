import { matchesServiceHost } from "../hostnames.js";
import type { Media, DownloadRequest, Variant } from "../../domain/media.js";
import {
  type DownloadService,
  type ServiceContext,
  type DownloadPlan,
  type RefreshContext,
  type QueueContext,
} from "../contracts.js";
import { inspectCommon } from "../shared/inspect.js";
import { prepareCommon } from "../shared/prepare.js";
import { resolveYouTube, probeYouTubeEntry } from "./resolver.js";
export async function refreshYouTube(
  media: Media,
  force: boolean,
  context: RefreshContext,
): Promise<Media> {
  if (!media.videoId && media.kind !== "youtube") return media;
  if (media.accessError) throw new Error(media.accessError);
  const expires = media.entries?.length
    ? Math.min(
        ...media.entries.map(
          (entry) => Number(new URL(entry.url).searchParams.get("expire")) || 0,
        ),
      )
    : 0;
  if (
    !force &&
    media.entries?.length &&
    (Date.now() - (media.resolvedAt || 0) < 60000 ||
      expires > Date.now() / 1000 + 30)
  )
    return media;
  const info = await resolveYouTube(media.videoId, {
    readPlayer: context.readPlayer,
    observed: context.observed,
  });
  Object.assign(media, info, { resolutionError: info.unavailableReason });
  context.onChange();
  if (!info.entries.length) throw new Error(info.unavailableReason);
  return media;
}
export async function prepareQueuedYouTube(
  request: DownloadRequest,
  context: QueueContext & { probe?: (entry: Variant) => Promise<void> },
): Promise<void> {
  if (!request.media.videoId && request.media.kind !== "youtube") return;
  const wanted = request.formatId;
  for (let attempt = 0; attempt < 2; attempt++) {
    request.media = await context.refreshMedia(request.media, attempt > 0);
    const index = request.media.entries.findIndex(
      (entry) => entry.formatId === wanted,
    );
    if (index < 0)
      throw new Error(
        "Выбранное качество YouTube больше не доступно. Обновите список качеств.",
      );
    request.selection = index;
    const selected = request.media.entries[index];
    await context.configureHeaders({
      ...request.media,
      url: selected.url,
      audioUrl: selected.audioUrl,
    });
    try {
      await (context.probe || probeYouTubeEntry)(selected);
      break;
    } catch (error) {
      if (attempt || error.status !== 403) throw error;
    }
  }
}
export async function downloadYouTube(
  media: Media,
  selection: number,
  context: ServiceContext,
): Promise<DownloadPlan> {
  const result = await context.inspect(media),
    variant = result.variants[selection];
  if (!variant) throw new Error("Выбранное качество больше не доступно.");
  if (variant.kind === "sabr")
    return {
      media: { ...media, kind: "sabr", hasAudio: true },
      variant,
      live: false,
      duration: media.duration,
    };
  return prepareCommon(media, selection, context);
}
export const youtubeService: DownloadService = {
  id: "youtube",
  matches: (url) => matchesServiceHost(url, "youtube"),
  inspect: inspectCommon,
  download: downloadYouTube,
  refresh: refreshYouTube,
  prepareQueued: prepareQueuedYouTube,
};
