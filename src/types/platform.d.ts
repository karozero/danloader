// Browser/page integration points supplied by the host and the vendor runtime.
interface FileSystemSyncAccessHandle {
  read(buffer: ArrayBufferView, options?: { at?: number }): number;
  write(buffer: ArrayBufferView, options?: { at?: number }): number;
  getSize(): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}
interface FileSystemFileHandle {
  createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle>;
}
interface Window {
  playerOptions?: Record<string, any>;
  ytInitialPlayerResponse?: Record<string, any>;
  playerConfig?: Record<string, any>;
  __playerdata__?: Record<string, any>;
  DanVideoSession?: {
    ready(videoId?: string): boolean;
    request(data: any): Promise<any>;
  };
}
interface HTMLElement {
  getPlayerResponse?: () => Record<string, any>;
}
declare module "*vendor/sabr.mjs" {
  export { SabrStream } from "googlevideo/sabr-stream";
  export { VideoPlaybackAbrRequest } from "googlevideo/protos";
  export { buildSabrFormat, Logger } from "googlevideo/utils";
}
