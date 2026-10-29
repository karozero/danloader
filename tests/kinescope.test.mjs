import test from "node:test";
import assert from "node:assert/strict";
import {
  kinescopeCandidate,
  kinescopeVideoId,
} from "../dist/services/kinescope/discovery.js";
import {
  serviceForUrl,
  getDownloadService,
} from "../dist/services/registry.js";
import { staticHlsTrack } from "../dist/core/hls-static.js";
import { downloadHls } from "../dist/application/download-hls.js";
import { createDownloadEngine } from "../dist/application/download-engine.js";
import { visibleMedia } from "../dist/core/discovery.js";
const page = "https://kinescope.io/embed/currentAlias",
  master = "https://cdn.test/current/master.m3u8?sig=keep%2Bexact";
const current = {
  id: "canonical-current",
  title: "Current Kinescope video",
  meta: { url: "https://kinescope.io/currentAlias", duration: 123.4 },
  poster: { src: { src: "https://cdn.test/poster.jpg" } },
  sources: { hls: { src: master }, shakahls: { src: master } },
};

test("Kinescope resolves its iframe on Sponsr through the player service and rejects lookalike hosts", () => {
  assert.equal(serviceForUrl(page).id, "kinescope");
  assert.equal(
    serviceForUrl("https://kinescope.io.evil.test/embed/id").id,
    "generic",
  );
  assert.equal(
    getDownloadService({
      id: "v",
      url: master,
      kind: "hls",
      pageUrl: page,
      servicePageUrl: "https://sponsr.ru/greenpig/190230/",
    }).id,
    "kinescope",
  );
  assert.equal(
    kinescopeVideoId("https://kinescope.io/embed/pl/other"),
    undefined,
  );
});

test("Kinescope bootstrap chooses the current playlist item, keeps signed URLs, title, poster and duration", () => {
  const next = {
    ...current,
    id: "canonical-next",
    meta: { url: "https://kinescope.io/nextAlias", duration: 900 },
    sources: { hls: { src: "https://cdn.test/next/master.m3u8" } },
  };
  const candidate = kinescopeCandidate({ playlist: [next, current] }, page);
  assert.equal(candidate.videoId, "canonical-current");
  assert.equal(candidate.title, current.title);
  assert.equal(candidate.url, master);
  assert.equal(candidate.thumbnail, "https://cdn.test/poster.jpg");
  assert.equal(candidate.duration, 123.4);
  assert.equal(candidate.groupId, "kinescope:canonical-current");
  assert.equal(candidate.entries, undefined);
  assert.equal(
    kinescopeCandidate({ playlist: [next] }, page, {
      url: next.sources.hls.src,
      text: "#EXTM3U",
      kind: "hls",
    }),
    undefined,
  );
  assert.equal(
    kinescopeCandidate({ playlist: [current] }, "https://sponsr.ru/post"),
    undefined,
  );
});

test("Kinescope fragment embeds use only the observed restricted manifest and do not expose full-video sources", () => {
  const clipped = page + "?seek=60&duration=30";
  assert.equal(kinescopeCandidate({ playlist: [current] }, clipped), undefined);
  const restricted = master + "&seek=60&duration=30",
    candidate = kinescopeCandidate({ playlist: [current] }, clipped, {
      url: restricted,
      text: "#EXTM3U",
      kind: "hls",
    });
  assert.equal(candidate.url, restricted);
  assert.equal(candidate.duration, undefined);
  assert.deepEqual(candidate.sourceUrls, [restricted]);
  assert.equal(
    kinescopeCandidate({ playlist: [{ ...current, hasAccess: false }] }, page),
    undefined,
  );
  assert.equal(
    kinescopeCandidate(
      {
        playlist: [
          {
            ...current,
            drm: { widevine: { licenseUrl: "https://license.test" } },
          },
        ],
      },
      page,
    ).drm,
    true,
  );
});

const rangePlaylist =
  '#EXTM3U\n#EXT-X-MAP:URI="asset.mp4?sig=keep",BYTERANGE="4@0"\n#EXTINF:4,\n#EXT-X-BYTERANGE:3@4\nasset.mp4?sig=keep\n#EXTINF:2,\n#EXT-X-BYTERANGE:2\nasset.mp4?sig=keep\n#EXT-X-ENDLIST';
test("Kinescope range playlists retain exact initialization, explicit and implicit ranges and authorization", () => {
  assert.equal(staticHlsTrack(rangePlaylist, master), undefined);
  const plan = staticHlsTrack(rangePlaylist, master, { allowByteRanges: true });
  assert.equal(plan.duration, 6);
  assert.deepEqual(plan.pieces, [
    {
      url: "https://cdn.test/current/asset.mp4?sig=keep",
      range: { offset: 0, length: 4 },
    },
    {
      url: "https://cdn.test/current/asset.mp4?sig=keep",
      range: { offset: 4, length: 3 },
    },
    {
      url: "https://cdn.test/current/asset.mp4?sig=keep",
      range: { offset: 7, length: 2 },
    },
  ]);
  assert.equal(
    staticHlsTrack(
      rangePlaylist.replace(
        "#EXT-X-BYTERANGE:2\nasset.mp4?sig=keep",
        "#EXT-X-BYTERANGE:2\nanother.mp4",
      ),
      master,
      { allowByteRanges: true },
    ),
    undefined,
  );
  assert.equal(
    staticHlsTrack(rangePlaylist.replace("3@4", "9007199254740991@4"), master, {
      allowByteRanges: true,
    }),
    undefined,
  );
});

test("Kinescope range downloader reconstructs precisely the requested bytes and refuses mismatched/ignored ranges", async () => {
  const track = staticHlsTrack(rangePlaylist, master, {
      allowByteRanges: true,
    }),
    asset = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
    out = [],
    requests = [];
  const spool = async () => {
    let chunks = [];
    return {
      reset() {
        chunks = [];
      },
      write(chunk) {
        chunks.push(chunk);
      },
      *chunks() {
        yield* chunks;
      },
      async dispose() {},
    };
  };
  await downloadHls(
    { video: track },
    {
      createSpool: spool,
      sinks: { video: (chunk) => out.push(...chunk) },
      fetcher: async (url, signal, range) => {
        requests.push({ url, range });
        return new Response(
          asset.slice(range.offset, range.offset + range.length),
          {
            status: 206,
            headers: {
              "content-range": `bytes ${range.offset}-${range.offset + range.length - 1}/10`,
            },
          },
        );
      },
    },
  );
  assert.deepEqual(out, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(requests.length, 3);
  for (const response of [
    new Response(asset),
    new Response(asset.slice(0, 4), {
      status: 206,
      headers: { "content-range": "bytes 1-4/10" },
    }),
  ])
    await assert.rejects(
      () =>
        downloadHls(
          { video: { pieces: [track.pieces[0]], duration: 1 } },
          {
            createSpool: spool,
            sinks: {
              video() {
                throw new Error("Must not append a bad range");
              },
            },
            fetcher: async () => response,
          },
        ),
      /диапазон|сегмент/,
    );
});

test("Kinescope download planning preserves selected video quality and the default audio track for range HLS", async () => {
  const root =
    '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",DEFAULT=YES,URI="audio.m3u8?lang=fr"\n#EXT-X-STREAM-INF:BANDWIDTH=100000,RESOLUTION=640x360,AUDIO="a"\nvideo.m3u8?quality=360\n';
  const engine = createDownloadEngine({
    loadManifest: async (url) => (url === master ? root : rangePlaylist),
    prepareUrls: async () => {},
  });
  const plan = await engine.download(
    { id: "ks", url: master, kind: "hls", pageUrl: page },
    0,
  );
  assert.equal(plan.variant.label, "360p");
  assert.equal(
    plan.variant.audioUrl,
    "https://cdn.test/current/audio.m3u8?lang=fr",
  );
  assert.equal(plan.variant.hls.video.pieces.length, 3);
  assert.equal(plan.variant.hls.audio.pieces.length, 3);
  assert.equal(plan.duration, 6);
});

test("A Kinescope iframe remains one card even when master, alternative manifest, media playlist and MP4 ranges are observed", () => {
  const base = { frameId: 3, pageUrl: page };
  const group = {
    ...base,
    id: "ks",
    url: master,
    kind: "hls",
    provider: "kinescope",
    groupId: "kinescope:canonical-current",
    sourceUrls: [master, "https://cdn.test/alt.mpd"],
    manifestText: "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000\nvideo.m3u8\n",
  };
  const rawMaster = { ...base, url: master, kind: "hls" },
    child = {
      ...base,
      url: "https://cdn.test/current/video.m3u8",
      kind: "hls",
      manifestText: rangePlaylist,
    },
    piece = {
      ...base,
      url: "https://cdn.test/current/asset.mp4?sig=keep",
      kind: "file",
      size: 100000000,
      source: "network",
    };
  assert.deepEqual(
    visibleMedia([
      group,
      rawMaster,
      child,
      piece,
      { ...base, url: "https://cdn.test/alt.mpd", kind: "dash" },
    ]).map((m) => m.id),
    ["ks"],
  );
});
