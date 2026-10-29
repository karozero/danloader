interface RemuxOptions {
  file: string;
  container: string;
  duration?: number;
  onProgress?: (percent: number | null) => void;
}
const EOF = -541478725;
const timestamp = (packet, key) => {
  const value = (packet[key] >>> 0) + (packet[key + "hi"] || 0) * 4294967296;
  return value === -9223372036854775808 ? null : value;
};
export function shiftPacket(packet, seconds) {
  const delta = Math.round(
      (seconds * packet.time_base_den) / packet.time_base_num,
    ),
    result = { ...packet };
  for (const key of ["pts", "dts"]) {
    const original = timestamp(packet, key);
    if (original !== null) {
      const value = original + delta;
      result[key] = value >>> 0;
      result[key + "hi"] = Math.floor(value / 4294967296);
    }
  }
  return result;
}
const packetTime = (packet) =>
  ((timestamp(packet, "dts") ?? timestamp(packet, "pts") ?? 0) *
    packet.time_base_num) /
  packet.time_base_den;
// Packet copy avoids the bundled CLI scheduler. At most one small batch per track is resident.
export async function remuxLocalMedia(
  av,
  {
    inputs,
    requireAudio = false,
    normalizeStart = false,
    file,
    container,
    duration,
    onProgress = (_percent: number | null) => {},
  }: RemuxOptions & {
    inputs: { name: string; tracks: ("video" | "audio")[] }[];
    requireAudio?: boolean;
    normalizeStart?: boolean;
  },
) {
  const sources = [],
    demuxers = [];
  let packet, mux, io;
  try {
    for (const input of inputs) {
      const [context, streams] = await av.ff_init_demuxer_file(input.name);
      const demux = { context, sources: [], eof: false };
      demuxers.push(demux);
      for (const type of input.tracks) {
        const stream = streams.find(
          (s) => s.codec_type === (type === "video" ? 0 : 1),
        );
        if (!stream) {
          if (type === "video" || requireAudio || input.tracks.length === 1)
            throw new Error(
              type === "video"
                ? "Временная дорожка не содержит видео."
                : "Временная дорожка не содержит звук.",
            );
          continue;
        }
        const source = {
          context,
          stream,
          index: sources.length,
          queue: [],
          position: 0,
          end: 0,
          count: 0,
        };
        demux.sources.push(source);
        sources.push(source);
      }
    }
    if (!sources.some((s) => s.stream.codec_type === 0))
      throw new Error("В результате нет видеодорожки.");
    packet = await av.av_packet_alloc();
    if (!packet) throw new Error("Не удалось выделить память для объединения.");
    const fill = async (input) => {
      if (
        input.eof ||
        input.sources.some((source) => source.position < source.queue.length)
      )
        return;
      const [status, packets] = await av.ff_read_frame_multi(
        input.context,
        packet,
        { limit: 262144 },
      );
      for (const source of input.sources) {
        source.queue = packets[source.stream.index] || [];
        source.position = 0;
      }
      if (status === EOF) input.eof = true;
      else if (status < 0 && status !== -6)
        throw new Error("Ошибка чтения дорожки (" + status + ").");
      if (!input.eof && !input.sources.some((source) => source.queue.length))
        throw new Error("Дорожка перестала передавать медиапакеты.");
    };
    for (const input of demuxers) await fill(input);
    const starts = sources.map((source) =>
      source.queue[0] ? packetTime(source.queue[0]) : 0,
    );
    const shift = -Math.min(...(normalizeStart ? starts : [0, ...starts]));
    const out = await av.ff_init_muxer(
      {
        filename: file,
        format_name: container === "mkv" ? "matroska" : "mp4",
        open: true,
        codecpars: true,
      },
      sources.map(({ stream }) => [
        stream.codecpar,
        stream.time_base_num,
        stream.time_base_den,
      ]),
    );
    [mux, , io] = out;
    if ((await av.avformat_write_header(mux, 0)) < 0)
      throw new Error("Не удалось создать заголовок итогового видео.");
    const timeBases = await Promise.all(
      out[3].map(async (stream) => [
        await av.AVStream_time_base_num(stream),
        await av.AVStream_time_base_den(stream),
      ]),
    );
    let last = 0;
    while (true) {
      for (const input of demuxers) await fill(input);
      const available = sources.filter(
        (source) => source.position < source.queue.length,
      );
      if (!available.length) break;
      const source = available.sort(
        (a, b) =>
          packetTime(a.queue[a.position]) - packetTime(b.queue[b.position]),
      )[0];
      const original = source.queue[source.position++],
        p = shiftPacket(original, shift);
      p.stream_index = source.index;
      await av.ff_copyin_packet(packet, p);
      const [num, den] = timeBases[source.index];
      await av.av_packet_rescale_ts_js(
        packet,
        p.time_base_num,
        p.time_base_den,
        num,
        den,
      );
      const status = await av.av_interleaved_write_frame(mux, packet);
      await av.av_packet_unref(packet);
      if (status < 0)
        throw new Error("Не удалось записать медиапакет (" + status + ").");
      const pts = timestamp(p, "pts") ?? timestamp(p, "dts") ?? 0;
      source.end = Math.max(
        source.end,
        ((pts + (p.duration || 0)) * p.time_base_num) / p.time_base_den,
      );
      source.count++;
      if (Date.now() - last > 250) {
        onProgress(
          duration
            ? Math.min(
                99,
                (Math.min(...sources.map((s) => s.end)) / duration) * 100,
              )
            : null,
        );
        last = Date.now();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    if (
      sources.some((source) => !source.count) ||
      (duration && sources.some((source) => source.end < duration * 0.9))
    )
      throw new Error(
        "Объединение получило неполную дорожку. Файл не сохранён.",
      );
    if ((await av.av_write_trailer(mux)) < 0)
      throw new Error("Не удалось завершить итоговый контейнер.");
    await av.avio_flush(io);
    return Math.min(...sources.map((source) => source.end)) * 1000;
  } finally {
    if (mux) await av.ff_free_muxer(mux, io);
    if (packet) await av.av_packet_free_js(packet);
    for (const input of demuxers)
      await av.avformat_close_input_js(input.context);
  }
}

export function remuxLocalTracks(
  av,
  { video, audio, ...options }: RemuxOptions & { video: string; audio: string },
) {
  return remuxLocalMedia(av, {
    ...options,
    requireAudio: true,
    inputs: [
      { name: video, tracks: ["video"] },
      { name: audio, tracks: ["audio"] },
    ],
  });
}
