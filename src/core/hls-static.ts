import { attributes } from "./hls.js";
import { httpUrl } from "./media.js";
export interface HlsByteRange {
  offset: number;
  length: number;
}
export type HlsPiece = string | { url: string; range: HlsByteRange };
export interface HlsTrack {
  pieces: HlsPiece[];
  duration: number;
}
export interface StaticHls {
  video: HlsTrack;
  audio?: HlsTrack;
}
/** Only complete, unencrypted and continuous VOD playlists take the local fast path. */
export function staticHlsTrack(
  text: string,
  url: string,
  { allowByteRanges = false } = {},
): HlsTrack | undefined {
  const lines = text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim());
  if (lines[0] !== "#EXTM3U" || !lines.includes("#EXT-X-ENDLIST")) return;
  if (
    lines.some((line) =>
      /^#EXT-X-(?:STREAM-INF|I-FRAMES-ONLY|DISCONTINUITY|GAP|PART|PRELOAD-HINT|SKIP|DEFINE|SESSION-KEY)(?::|$)/.test(
        line,
      ),
    )
  )
    return;
  if (
    !allowByteRanges &&
    lines.some((line) => line.startsWith("#EXT-X-BYTERANGE:"))
  )
    return;
  const pieces: HlsPiece[] = [];
  let pendingRange: string | undefined,
    previousUrl: string | undefined,
    previousEnd: number | undefined;
  let duration = 0,
    pendingDuration: number | undefined,
    init: HlsPiece | undefined;
  for (const line of lines) {
    if (line.startsWith("#EXT-X-KEY:")) {
      if (attributes(line).METHOD !== "NONE") return;
    } else if (line.startsWith("#EXT-X-MAP:")) {
      const attrs = attributes(line),
        resolved = httpUrl(attrs.URI, url);
      if (
        !resolved ||
        (attrs.BYTERANGE && !allowByteRanges) ||
        (init && (typeof init === "string" ? init : init.url) !== resolved) ||
        pieces.length
      )
        return;
      if (attrs.BYTERANGE) {
        const range = parseRange(attrs.BYTERANGE);
        if (!range) return;
        init = { url: resolved, range };
      } else init = resolved;
    } else if (line.startsWith("#EXT-X-BYTERANGE:")) {
      if (pendingRange !== undefined) return;
      pendingRange = line.slice(17);
    } else if (line.startsWith("#EXTINF:")) {
      if (pendingDuration !== undefined) return;
      pendingDuration = Number.parseFloat(line.slice(8));
      if (!(pendingDuration > 0)) return;
    } else if (line && !line.startsWith("#")) {
      const resolved = httpUrl(line, url);
      if (!resolved || pendingDuration === undefined) return;
      if (pendingRange !== undefined) {
        const range = parseRange(
          pendingRange,
          previousUrl === resolved ? previousEnd : undefined,
        );
        if (!range) return;
        pieces.push({ url: resolved, range });
        previousUrl = resolved;
        previousEnd = range.offset + range.length;
        pendingRange = undefined;
      } else {
        pieces.push(resolved);
        previousUrl = undefined;
        previousEnd = undefined;
      }
      duration += pendingDuration;
      pendingDuration = undefined;
      if (pieces.length > 100000) return;
    }
  }
  if (
    !pieces.length ||
    pendingDuration !== undefined ||
    pendingRange !== undefined
  )
    return;
  return { pieces: init ? [init, ...pieces] : pieces, duration };
}

function parseRange(
  value: string,
  implicit?: number,
): HlsByteRange | undefined {
  const match = /^(\d+)(?:@(\d+))?$/.exec(value);
  if (!match) return;
  const length = Number(match[1]),
    offset = match[2] === undefined ? implicit : Number(match[2]);
  if (
    !Number.isSafeInteger(length) ||
    length <= 0 ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(offset + length)
  )
    return;
  return { offset, length };
}
