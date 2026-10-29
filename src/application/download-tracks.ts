import type { StaticTracks, TrackType } from "../domain/media.js";
export async function downloadTracks({
  tracks,
  fetcher,
  sinks,
  onProgress = () => {},
}: {
  tracks: StaticTracks;
  fetcher: (url: string) => Promise<Response>;
  sinks: Record<TrackType, (data: Uint8Array) => void | Promise<void>>;
  onProgress?: (bytes: number, percent: number) => void;
}) {
  const state = (["video", "audio"] as const).map((type) => ({
    type,
    pieces: tracks[type],
    done: 0,
    fraction: 0,
    bytes: 0,
    total: 0,
  }));
  const pieces = state.reduce((sum, item) => sum + item.pieces.length, 0);
  let percent = 0;
  const report = () => {
    const known = state.every(
        (item) => item.pieces.length === 1 && item.total > 0,
      ),
      bytes = state.reduce((sum, item) => sum + item.bytes, 0),
      total = state.reduce((sum, item) => sum + item.total, 0);
    percent = Math.max(
      percent,
      Math.min(
        99,
        known
          ? (bytes / total) * 100
          : (state.reduce((sum, item) => sum + item.done + item.fraction, 0) /
              pieces) *
              100,
      ),
    );
    onProgress(bytes, percent);
  };
  await Promise.all(
    state.map(async (item) => {
      for (const url of item.pieces) {
        const response = await fetcher(url);
        if (!(response instanceof Response) || !response.ok)
          throw new Error("Не удалось получить целую дорожку Instagram.");
        if (response.status === 206) {
          const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
            response.headers.get("content-range") || "",
          );
          if (!range || +range[1] !== 0 || +range[2] + 1 !== +range[3])
            throw new Error("Источник вернул только диапазон дорожки.");
        }
        if (
          /text\/html|application\/json/i.test(
            response.headers.get("content-type") || "",
          )
        )
          throw new Error("Источник вернул страницу вместо дорожки.");
        const total = Number(response.headers.get("content-length")) || 0;
        if (item.pieces.length === 1) item.total = total;
        const reader = response.body.getReader();
        let received = 0;
        try {
          while (true) {
            let timer;
            const result = await Promise.race([
              reader.read(),
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () =>
                    reject(new Error("Дорожка перестала передавать данные.")),
                  30000,
                );
              }),
            ]).finally(() => clearTimeout(timer));
            if (result.done) break;
            await sinks[item.type](result.value);
            received += result.value.length;
            item.bytes += result.value.length;
            item.fraction = total ? received / total : 0;
            report();
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
        if (!received || (total && received !== total))
          throw new Error("Дорожка получена не полностью.");
        item.done++;
        item.fraction = 0;
        report();
      }
    }),
  );
  return state.reduce((sum, item) => sum + item.bytes, 0);
}
