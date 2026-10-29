import { matchesServiceHost } from "../hostnames.js";
import type { Media } from "../../domain/media.js";
import {
  type DownloadService,
  type ServiceContext,
  type DownloadPlan,
} from "../contracts.js";
import { inspectCommon } from "../shared/inspect.js";
import { prepareCommon } from "../shared/prepare.js";
/** Boosty owns the grouped player ID; common transport expands only the selected quality. */
export async function downloadBoosty(
  media: Media,
  selection: number,
  context: ServiceContext,
): Promise<DownloadPlan> {
  return prepareCommon(media, selection, context);
}
export const boostyService: DownloadService = {
  id: "boosty",
  matches: (url) => matchesServiceHost(url, "boosty"),
  inspect: inspectCommon,
  download: downloadBoosty,
};
