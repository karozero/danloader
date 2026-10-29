import { kinescopeService } from "./kinescope/downloader.js";
import type { Media } from "../domain/media.js";
import type { DownloadService } from "./contracts.js";
import { youtubeService } from "./youtube/downloader.js";
import { instagramService } from "./instagram/downloader.js";
import { boostyService } from "./boosty/downloader.js";
import { genericService } from "./generic/downloader.js";
const services: readonly DownloadService[] = [
  youtubeService,
  instagramService,
  boostyService,
  kinescopeService,
];
export function serviceForUrl(value?: string): DownloadService {
  try {
    const url = new URL(value);
    return services.find((service) => service.matches(url)) || genericService;
  } catch {
    return genericService;
  }
}
/** The owning frame URL and the current tab URL take precedence over candidate labels and CDN hosts. */
export function getDownloadService(media: Media): DownloadService {
  for (const url of [media.pageUrl, media.servicePageUrl, media.url]) {
    const service = serviceForUrl(url);
    if (service.id !== "generic") return service;
  }
  // Preserve ownership for retained CDN-only records and embedded players without a recognized frame URL.
  if (media.provider === "youtube") return youtubeService;
  if (media.provider === "instagram") return instagramService;
  if (media.provider === "kinescope") return kinescopeService;
  if (media.groupId?.startsWith("boosty:")) return boostyService;
  return genericService;
}
