import type { DownloadJob, JobStatus, Progress } from "../domain/media.js";
import { terminal } from "../core/media.js";
const stages: Partial<Record<JobStatus, number>> = {
  queued: 0,
  preparing: 1,
  downloading: 2,
  finalizing: 3,
  saving: 4,
};
/** Late network notifications must not move saving/merging back to downloading. */
export function applyProgress(job: DownloadJob, message: Progress): void {
  if (terminal(job.status)) return;
  const status = message.status || "downloading";
  const forward = (stages[status] ?? -1) >= (stages[job.status] ?? -1);
  job.bytes = Math.max(job.bytes || 0, Number(message.bytes) || 0);
  job.outputBytes = Math.max(
    job.outputBytes || 0,
    Number(message.outputBytes) || 0,
  );
  job.savedBytes = Math.max(
    job.savedBytes || 0,
    Number(message.savedBytes) || 0,
  );
  if (typeof message.live === "boolean") job.live = message.live;
  if (forward) {
    job.status = status;
    job.percent = Number.isFinite(message.percent)
      ? Math.max(0, Math.min(99, message.percent))
      : null;
  }
}
