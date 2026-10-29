import { resolveOutput, type MediaOutput } from "../domain/media-output.js";
import { assertOutputEnabled } from "./output-capabilities.js";
import type { Media, QualityResult } from "../domain/media.js";
import type { ServiceContext, DownloadPlan } from "../services/contracts.js";
import { getDownloadService } from "../services/registry.js";
export type DownloadPorts = Pick<
  ServiceContext,
  "loadManifest" | "prepareUrls"
>;
export function createDownloadEngine(ports: DownloadPorts) {
  const inspections = new Map<
    string,
    { result: QualityResult; time: number }
  >();
  const key = (media: Media) =>
    [
      getDownloadService(media).id,
      media.id,
      media.qualityRevision || 0,
      media.resolvedAt || 0,
    ].join(":");
  function context(signal?: AbortSignal, output?: MediaOutput): ServiceContext {
    return {
      ...ports,
      signal,
      output,
      inspect: (media, fresh = false) => inspect(media, signal, !fresh),
    };
  }
  async function inspect(
    media: Media,
    signal?: AbortSignal,
    useCache = false,
  ): Promise<QualityResult> {
    signal?.throwIfAborted();
    if (media.drm) throw new Error("Видео защищено DRM и не поддерживается.");
    const cached = inspections.get(key(media));
    if (useCache && cached && Date.now() - cached.time < 30000)
      return cached.result;
    const result = await getDownloadService(media).inspect(
      media,
      context(signal),
    );
    if (!result.variants?.length)
      throw new Error("В источнике не найдены доступные качества.");
    if (result.drm) throw new Error("Видео защищено DRM и не поддерживается.");
    signal?.throwIfAborted();
    await ports.prepareUrls(media, result.urls || []);
    inspections.set(key(media), { result, time: Date.now() });
    while (inspections.size > 100)
      inspections.delete(inspections.keys().next().value);
    return result;
  }
  async function download(
    media: Media,
    selection = 0,
    signal?: AbortSignal,
    output?: MediaOutput,
  ): Promise<DownloadPlan> {
    signal?.throwIfAborted();
    const target = resolveOutput(output);
    assertOutputEnabled(target);
    const plan = await getDownloadService(media).download(
      media,
      selection,
      context(signal, target),
    );
    return { ...plan, output: target };
  }
  return { inspect, download };
}
