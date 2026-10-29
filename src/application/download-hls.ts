import type { StaticHls, HlsByteRange } from "../core/hls-static.js";
export interface SegmentSpool {
  reset(): void;
  write(data: Uint8Array): void;
  chunks(): Iterable<Uint8Array>;
  dispose(): Promise<void>;
}
export interface HlsDownloadPorts {
  fetcher(
    url: string,
    signal: AbortSignal,
    range?: HlsByteRange,
  ): Promise<Response>;
  createSpool(slot: number): Promise<SegmentSpool>;
  sinks: {
    video(data: Uint8Array): void | Promise<void>;
    audio?(data: Uint8Array): void | Promise<void>;
  };
  signal?: AbortSignal;
  onProgress?(bytes: number, percent: number): void;
}
async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout>;
  let abort: () => void;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Сегмент HLS перестал передавать данные.")),
      30000,
    );
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([reader.read(), deadline]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
/** Four disk-backed slots bound concurrency and RAM, and preserve source order even when responses finish out of order. */
export async function downloadHls(
  plan: StaticHls,
  ports: HlsDownloadPorts,
): Promise<number> {
  const cancel = new AbortController(),
    signal = ports.signal
      ? AbortSignal.any([ports.signal, cancel.signal])
      : cancel.signal;
  const tracks = (
    [
      { type: "video", track: plan.video },
      { type: "audio", track: plan.audio },
    ] as const
  ).filter((item) => item.track);
  const total = tracks.reduce((sum, item) => sum + item.track.pieces.length, 0),
    slots: SegmentSpool[] = [];
  let bytes = 0,
    done = 0;
  const fractions = new Map<number, number>();
  const report = () =>
    ports.onProgress?.(
      bytes,
      Math.min(
        99,
        ((done + [...fractions.values()].reduce((a, b) => a + b, 0)) / total) *
          100,
      ),
    );
  try {
    for (let index = 0; index < Math.min(4, total); index++)
      slots.push(await ports.createSpool(index));
    for (const { type, track } of tracks) {
      const sink = ports.sinks[type];
      if (!sink) throw new Error("Нет приёмника аудиодорожки HLS.");
      for (
        let offset = 0;
        offset < track.pieces.length;
        offset += slots.length
      ) {
        signal.throwIfAborted();
        const batch = track.pieces.slice(offset, offset + slots.length);
        const pending = batch.map(async (piece, index) => {
          const url = typeof piece === "string" ? piece : piece.url;
          const requested = typeof piece === "string" ? undefined : piece.range;
          const spool = slots[index];
          spool.reset();
          const response = await ports.fetcher(url, signal, requested);
          if (
            !(response instanceof Response) ||
            !response.ok ||
            !response.body
          ) {
            if (response instanceof Response)
              await response.body?.cancel().catch(() => {});
            throw new Error("Не удалось получить сегмент HLS.");
          }
          if (requested && response.status !== 206) {
            await response.body.cancel().catch(() => {});
            throw new Error("Сервер не выполнил точный диапазон HLS.");
          }
          if (response.status === 206) {
            const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
              response.headers.get("content-range") || "",
            );
            if (
              !range ||
              (requested
                ? +range[1] !== requested.offset ||
                  +range[2] + 1 !== requested.offset + requested.length ||
                  +range[3] < requested.offset + requested.length
                : +range[1] !== 0 || +range[2] + 1 !== +range[3])
            ) {
              await response.body.cancel().catch(() => {});
              throw new Error("Источник вернул неполный сегмент HLS.");
            }
          }
          if (
            /text\/html|application\/json/i.test(
              response.headers.get("content-type") || "",
            )
          ) {
            await response.body.cancel().catch(() => {});
            throw new Error("Источник вернул страницу вместо сегмента HLS.");
          }
          const expected = requested
              ? requested.length
              : /^(?:identity)?$/i.test(
                    response.headers.get("content-encoding") || "",
                  )
                ? Number(response.headers.get("content-length")) || 0
                : 0,
            reader = response.body.getReader();
          let received = 0;
          try {
            while (true) {
              signal.throwIfAborted();
              const chunk = await readChunk(reader, signal);
              if (chunk.done) break;
              spool.write(chunk.value);
              received += chunk.value.byteLength;
              bytes += chunk.value.byteLength;
              fractions.set(
                index,
                expected ? Math.min(1, received / expected) : 0,
              );
              report();
            }
          } finally {
            await reader.cancel().catch(() => {});
          }
          if (!received || (expected && received !== expected))
            throw new Error("Сегмент HLS получен не полностью.");
          fractions.set(index, 1);
        });
        try {
          await Promise.all(pending);
        } catch (error) {
          cancel.abort(error);
          await Promise.allSettled(pending);
          throw error;
        }
        for (let index = 0; index < batch.length; index++) {
          signal.throwIfAborted();
          for (const chunk of slots[index].chunks()) await sink(chunk);
          done++;
          fractions.delete(index);
          report();
        }
      }
    }
    return bytes;
  } finally {
    cancel.abort();
    await Promise.allSettled(slots.map((slot) => slot.dispose()));
  }
}
