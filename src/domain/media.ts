import type { StaticHls } from "../core/hls-static.js";
import type { MediaOutput } from "./media-output.js";
export type MediaKind =
  "file" | "audio" | "hls" | "dash" | "pair" | "youtube" | "sabr" | "tracks";
export type TrackType = "video" | "audio";
export type StaticTracks = Record<TrackType, string[]>;
export interface Variant {
  hls?: StaticHls;
  label?: string;
  url?: string;
  audioUrl?: string;
  kind?: MediaKind;
  height?: number;
  width?: number;
  fps?: number | string;
  qualityHeight?: number;
  bitrate?: number;
  bandwidth?: number;
  mime?: string;
  codecs?: string;
  formatId?: string;
  manifestText?: string;
  tracks?: StaticTracks;
  hasAudio?: boolean;
  audioGroup?: string;
  sabrVideo?: Record<string, unknown>;
  sabrAudio?: Record<string, unknown>;
}
export interface QualityResult {
  variants: Variant[];
  drm?: boolean;
  live?: boolean;
  duration?: number;
  hasAudio?: boolean;
  urls?: string[];
}
export interface Media extends Variant {
  id: string;
  key?: string;
  tabId?: number;
  playback?: {
    group: string;
    audio: boolean;
    needsAudio: boolean;
    itag: number;
  };
  title?: string;
  kind: MediaKind;
  url: string;
  frameId?: number;
  pageUrl?: string;
  /** Current tab URL captured when inspecting/enqueueing, retained while the queue runs. */
  servicePageUrl?: string;
  provider?: string;
  source?: string;
  sourceUrls?: string[];
  groupId?: string;
  entries?: Variant[];
  thumbnail?: string;
  duration?: number;
  quality?: string;
  qualityRevision?: number;
  isCurrent?: boolean;
  reelCode?: string;
  instagramMediaId?: string;
  aliasGroupIds?: string[];
  videoId?: string;
  needsAudio?: boolean;
  resolutionError?: string;
  accessError?: string;
  size?: number;
  qualities?: { label: string }[];
  mime?: string;
  drm?: boolean;
  resolvedAt?: number;
  seen?: number;
  documentId?: string;
}
export type Candidate = Partial<Media> & Pick<Media, "url" | "kind">;
export type JobStatus =
  | "queued"
  | "preparing"
  | "downloading"
  | "finalizing"
  | "saving"
  | "complete"
  | "failed"
  | "cancelled";
export interface DownloadRequest {
  output?: MediaOutput;
  media: Media;
  variant?: Variant;
  selection?: number;
  formatId?: string;
  container: string;
  filename?: string;
  destination?: Destination;
  duration?: number;
  live?: boolean;
}
export interface DownloadJob {
  id: string;
  tabId: number;
  title: string;
  status: JobStatus;
  bytes: number;
  started: number;
  request?: DownloadRequest;
  error?: string;
  percent?: number;
  outputBytes?: number;
  savedBytes?: number;
  live?: boolean;
  browserId?: number;
  savedFilename?: string;
  folderName?: string;
  otherTab?: boolean;
}
export type Destination =
  | { mode: "browser" }
  | {
      mode: "directory";
      id: string;
      name: string;
      permission?: PermissionState;
    };
export interface Progress {
  status?: JobStatus;
  bytes?: number;
  outputBytes?: number;
  savedBytes?: number;
  percent?: number;
  live?: boolean;
}

export interface WorkerStart {
  output?: MediaOutput;
  type: "start";
  file: string;
  media: Media;
  variant: Variant;
  container: "mp4" | "mkv";
  duration?: number;
  live?: boolean;
}
export type WorkerRequest =
  | WorkerStart
  | { type: "stop" }
  | {
      type: "youtube-reply";
      uid: string;
      ok: boolean;
      value?: unknown;
      error?: string;
    };
