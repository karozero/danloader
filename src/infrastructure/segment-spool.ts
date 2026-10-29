import type { SegmentSpool } from "../application/download-hls.js";
export async function createSegmentSpool(
  root: FileSystemDirectoryHandle,
  name: string,
): Promise<SegmentSpool> {
  const file = await root.getFileHandle(name, { create: true }),
    handle = await file.createSyncAccessHandle();
  let size = 0;
  return {
    reset() {
      handle.truncate(0);
      size = 0;
    },
    write(data) {
      if (handle.write(data, { at: size }) !== data.byteLength)
        throw new Error("Недостаточно места для HLS-сегмента.");
      size += data.byteLength;
    },
    *chunks() {
      const buffer = new Uint8Array(Math.min(1024 * 1024, size));
      for (let at = 0; at < size;) {
        const count = handle.read(
          buffer.subarray(0, Math.min(buffer.length, size - at)),
          { at },
        );
        if (!count)
          throw new Error("Не удалось прочитать временный HLS-сегмент.");
        at += count;
        yield buffer.subarray(0, count);
      }
    },
    async dispose() {
      try {
        handle.close();
      } finally {
        await root.removeEntry(name).catch(() => {});
      }
    },
  };
}
