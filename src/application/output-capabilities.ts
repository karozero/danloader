import type { MediaOutput } from "../domain/media-output.js";
export class OutputNotEnabledError extends Error {
  readonly code = "OUTPUT_NOT_ENABLED";
  constructor(output: MediaOutput) {
    super("Скачивание " + output.kind + " пока не включено.");
    this.name = "OutputNotEnabledError";
  }
}
/** Audio has a typed intent and stream policy; execution stays disabled until its encoder/validation path is implemented. */
export function assertOutputEnabled(
  output: MediaOutput,
): asserts output is Extract<MediaOutput, { kind: "video" }> {
  if (output.kind !== "video") throw new OutputNotEnabledError(output);
}
