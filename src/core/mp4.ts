// Read only box headers and track metadata; never load a large video into memory to validate it.
export async function mp4Tracks(file: Blob) {
  let video = false,
    audio = false,
    payload = false,
    moov = false,
    visited = 0;
  async function boxes(start: number, end: number, depth = 0) {
    if (depth > 5) return;
    for (let offset = start; offset + 8 <= end;) {
      if (++visited > 20000) throw new Error("Слишком сложная структура MP4.");
      const bytes = new Uint8Array(
        await file.slice(offset, Math.min(offset + 24, end)).arrayBuffer(),
      );
      const view = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      );
      let size = view.getUint32(0),
        header = 8;
      const type = String.fromCharCode(...bytes.subarray(4, 8));
      if (size === 1) {
        if (bytes.length < 16) return;
        const large = view.getBigUint64(8);
        if (large > BigInt(Number.MAX_SAFE_INTEGER)) return;
        size = Number(large);
        header = 16;
      }
      if (size === 0) size = end - offset;
      if (size < header || offset + size > end) return;
      if (type === "mdat" && size > header) payload = true;
      if (type === "moov") {
        moov = true;
        await boxes(offset + header, offset + size, depth + 1);
      } else if (type === "trak" || type === "mdia")
        await boxes(offset + header, offset + size, depth + 1);
      else if (type === "hdlr" && size >= header + 12) {
        const handler = new Uint8Array(
          await file
            .slice(offset + header + 8, offset + header + 12)
            .arrayBuffer(),
        );
        const name = String.fromCharCode(...handler);
        video ||= name === "vide";
        audio ||= name === "soun";
      }
      offset += size;
    }
  }
  await boxes(0, file.size);
  return { video, audio, payload, moov };
}
export async function requireVideoMp4(
  file: Blob,
  { requireAudio = false } = {},
) {
  const tracks = await mp4Tracks(file);
  if (!tracks.moov || !tracks.video || !tracks.payload)
    throw new Error(
      "Источник вернул фрагмент или аудиодорожку вместо целого видео. Файл не сохранён.",
    );
  if (requireAudio && !tracks.audio)
    throw new Error(
      "В результате отсутствует аудиодорожка. Файл не сохранён как полное видео.",
    );
  return tracks;
}
