import type { Media } from "../../domain/media.js";
import { matchesServiceHost } from "../hostnames.js";
import type {
  DownloadService,
  ServiceContext,
  DownloadPlan,
} from "../contracts.js";
import { inspectCommon } from "../shared/inspect.js";
import { prepareCommon } from "../shared/prepare.js";
export async function downloadKinescope(
  media: Media,
  selection: number,
  context: ServiceContext,
): Promise<DownloadPlan> {
  const plan = await prepareCommon(media, selection, {
    ...context,
    allowHlsByteRanges: true,
  });
  if (plan.variant.tracks)
    return {
      ...plan,
      media: { ...plan.media, kind: "tracks", hasAudio: true },
      live: false,
    };
  return plan;
}
export const kinescopeService: DownloadService = {
  id: "kinescope",
  matches: (url) => matchesServiceHost(url, "kinescope"),
  inspect: inspectCommon,
  download: downloadKinescope,
};
