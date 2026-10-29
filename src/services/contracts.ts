import type { MediaOutput } from "../domain/media-output.js";
import type {
  Media,
  Variant,
  QualityResult,
  DownloadRequest,
} from "../domain/media.js";
export type ServiceId =
  "youtube" | "instagram" | "boosty" | "kinescope" | "generic";
export interface DownloadPlan {
  output?: MediaOutput;
  media: Media;
  variant: Variant;
  live?: boolean;
  duration?: number;
}
/** Ports keep browser messaging, network and cache ownership outside service-specific rules. */
export interface ServiceContext {
  allowHlsByteRanges?: boolean;
  output?: MediaOutput;
  signal?: AbortSignal;
  loadManifest(
    url: string,
    inline?: string,
    signal?: AbortSignal,
  ): Promise<string>;
  prepareUrls(media: Media, urls: string[]): Promise<void>;
  inspect(media: Media, fresh?: boolean): Promise<QualityResult>;
}
export interface RefreshContext {
  readPlayer(id: string): Promise<Record<string, any>>;
  observed: { itag?: string; lastModified?: string; url: string }[];
  onChange(): void;
}
export interface QueueContext {
  refreshMedia(media: Media, force?: boolean): Promise<Media>;
  configureHeaders(media: Media): Promise<void>;
}
export interface DownloadService {
  readonly id: ServiceId;
  matches(url: URL): boolean;
  inspect(media: Media, context: ServiceContext): Promise<QualityResult>;
  download(
    media: Media,
    selection: number,
    context: ServiceContext,
  ): Promise<DownloadPlan>;
  refresh?(
    media: Media,
    force: boolean,
    context: RefreshContext,
  ): Promise<Media>;
  prepareQueued?(
    request: DownloadRequest,
    context: QueueContext,
  ): Promise<void>;
}
export function matchesHost(url: URL, domain: string): boolean {
  return (
    /^https?:$/.test(url.protocol) &&
    !url.username &&
    !url.password &&
    (url.hostname === domain || url.hostname.endsWith("." + domain))
  );
}
