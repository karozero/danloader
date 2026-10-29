import type { Media } from "../../domain/media.js";
import type {
  DownloadService,
  ServiceContext,
  DownloadPlan,
} from "../contracts.js";
import { inspectCommon } from "../shared/inspect.js";
import { prepareCommon } from "../shared/prepare.js";
export async function downloadGeneric(
  media: Media,
  selection: number,
  context: ServiceContext,
): Promise<DownloadPlan> {
  return prepareCommon(media, selection, context);
}
export const genericService: DownloadService = {
  id: "generic",
  matches: () => true,
  inspect: inspectCommon,
  download: downloadGeneric,
};
