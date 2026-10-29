/** Output intent is independent of source transport (HTTP/HLS/DASH/SABR). */
export type VideoContainer = "mp4" | "mkv";
export type AudioContainer = "m4a" | "webm" | "mp3" | "opus";
export type MediaOutput =
  | { kind: "video"; container: VideoContainer }
  | { kind: "audio"; container: AudioContainer };
export interface OutputPolicy {
  extension: string;
  video: "required" | "excluded";
  audio: "optional" | "required";
}
export function videoOutput(
  container: unknown = "mp4",
): Extract<MediaOutput, { kind: "video" }> {
  return { kind: "video", container: container === "mkv" ? "mkv" : "mp4" };
}
/** Read old queued jobs as video, but never reinterpret an explicit audio request as video. */
export function resolveOutput(
  value: unknown,
  legacyContainer: unknown = "mp4",
): MediaOutput {
  if (value == null) return videoOutput(legacyContainer);
  if (typeof value !== "object")
    throw new Error("Некорректный тип результата скачивания.");
  const output = value as Record<string, unknown>;
  if (
    output.kind === "video" &&
    (output.container === "mp4" || output.container === "mkv")
  )
    return { kind: "video", container: output.container };
  if (
    output.kind === "audio" &&
    (output.container === "m4a" ||
      output.container === "webm" ||
      output.container === "mp3" ||
      output.container === "opus")
  )
    return { kind: "audio", container: output.container };
  throw new Error("Некорректный тип результата скачивания.");
}
export function outputPolicy(output: MediaOutput): OutputPolicy {
  return output.kind === "audio"
    ? { extension: output.container, video: "excluded", audio: "required" }
    : { extension: output.container, video: "required", audio: "optional" };
}
