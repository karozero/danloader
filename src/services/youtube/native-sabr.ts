import { sabrPercent } from "../../core/network-progress.js";
export const toBase64 = (bytes) => {
  let text = "";
  for (let i = 0; i < bytes.length; i += 32768)
    text += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(text);
};
export const fromBase64 = (text) =>
  Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
// Uses only a successful native page request. No alternate clients or attestation generators.
export async function downloadNativeSabr(
  {
    videoId,
    video,
    audio,
    requestPage,
    videoSink,
    audioSink,
    onProgress = (_bytes: number, _percent: number | null) => {},
    duration,
  },
  engine = undefined,
) {
  const { SabrStream, VideoPlaybackAbrRequest, buildSabrFormat, Logger } =
    engine || (await import("../../vendor/sabr.mjs"));
  Logger?.getInstance().setLogLevels();
  const session = await requestPage("session"),
    native = VideoPlaybackAbrRequest.decode(fromBase64(session.body));
  if (
    !native.streamerContext?.clientInfo ||
    !native.videoPlaybackUstreamerConfig?.length
  )
    throw new Error(
      "Обычный плеер не предоставил параметры SABR. Включите видео и повторите скачивание.",
    );
  const formats = [video, audio].map(buildSabrFormat);
  let stream,
    fatal,
    first = true;
  stream = new SabrStream({
    videoId,
    formats,
    serverAbrStreamingUrl: session.url,
    clientInfo: native.streamerContext.clientInfo,
    videoPlaybackUstreamerConfig: toBase64(native.videoPlaybackUstreamerConfig),
    poToken: native.streamerContext.poToken?.length
      ? toBase64(native.streamerContext.poToken)
      : undefined,
    fetchFunction: async (url, options) => {
      if (fatal) throw fatal;
      const packet = VideoPlaybackAbrRequest.decode(options.body);
      if (first) {
        packet.streamerContext = {
          ...native.streamerContext,
          ...packet.streamerContext,
          playbackCookie:
            packet.streamerContext?.playbackCookie ||
            native.streamerContext.playbackCookie,
          sabrContexts: [
            ...(native.streamerContext.sabrContexts || []),
            ...(packet.streamerContext?.sabrContexts || []),
          ],
        };
        first = false;
      }
      const result = await requestPage("fetch", {
        url: String(url),
        body: toBase64(VideoPlaybackAbrRequest.encode(packet).finish()),
      });
      if (!/yt-ump/i.test(result.mime || ""))
        throw new Error("YouTube вернул ответ без SABR-медиаданных.");
      return new Response(fromBase64(result.body), {
        headers: { "Content-Type": result.mime },
      });
    },
  });
  stream.on("streamProtectionStatusUpdate", (status) => {
    if ([2, 3].includes(status.status)) {
      fatal = new Error(
        "YouTube требует обновить подтверждение обычного воспроизведения. Откройте видео и повторите скачивание.",
      );
      stream.abort().catch(() => {});
    }
  });
  stream.on("error", (error) => {
    fatal = error;
  });
  let size = 0;
  const totalBytes =
    Number(video.contentLength || 0) + Number(audio.contentLength || 0);
  const report = () => {
    const end = (track) =>
      track?.bufferedRangeSummary
        ? track.bufferedRangeSummary.startTimeMs +
          track.bufferedRangeSummary.durationMs
        : 0;
    onProgress(
      size,
      sabrPercent({
        bytes: size,
        totalBytes: video.contentLength && audio.contentLength ? totalBytes : 0,
        duration,
        videoEnd: end(streamTracks?.video),
        audioEnd: end(streamTracks?.audio),
      }),
    );
  };
  let streamTracks;
  stream.on("trackStateUpdate", (tracks) => {
    streamTracks = tracks;
    report();
  });
  const result = stream.start({
    videoFormat: Number(video.itag),
    audioFormat: Number(audio.itag),
    isPostLiveDvr: false,
    maxRetries: 0,
    stallDetectionMs: 20000,
  });
  const consume = async (input, sink) => {
    const reader = input.getReader();
    try {
      while (true) {
        let timer;
        const chunk = await Promise.race([
          reader.read(),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("SABR перестал передавать данные.")),
              45000,
            );
          }),
        ]).finally(() => clearTimeout(timer));
        if (chunk.done) break;
        await sink(chunk.value);
        size += chunk.value.byteLength;
        report();
      }
    } finally {
      reader.releaseLock();
    }
  };
  try {
    await Promise.all([
      consume(result.videoStream, videoSink),
      consume(result.audioStream, audioSink),
    ]);
    if (fatal) throw fatal;
    if (
      !size ||
      (duration &&
        Math.min(stream.videoEndTimeMs, stream.audioEndTimeMs) < duration * 900)
    )
      throw new Error(
        "SABR передал неполное видео. Файл не будет сохранён как завершённый.",
      );
    onProgress(size, 100);
  } catch (error) {
    await stream.abort().catch(() => {});
    throw fatal || error;
  }
}
