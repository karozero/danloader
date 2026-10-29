import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { build } from "esbuild";
import { deflateSync } from "node:zlib";
const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "dist");
const inventory = JSON.parse(
  (
    await fs.readFile(path.join(root, "docs/original-inventory.json"), "utf8")
  ).replace(/^\uFEFF/, ""),
);
let originalPresent = true;
try {
  await fs.access(path.join(root, "../old_code"));
} catch {
  originalPresent = false;
}
if (originalPresent)
  for (const item of inventory) {
    const data = await fs.readFile(path.join(root, "../old_code", item.path));
    if (crypto.createHash("sha256").update(data).digest("hex") !== item.sha256)
      throw new Error("Original changed: " + item.path);
  }
for (const [source, destination] of [
  ["download_worker\\libav-6.5.7.1-h264-aac-mp3.wasm.mjs", "libav.mjs"],
  ["download_worker\\libav-6.5.7.1-h264-aac-mp3.wasm.wasm", "libav.wasm"],
]) {
  const expected = inventory.find((item) => item.path === source).sha256;
  const actual = crypto
    .createHash("sha256")
    .update(await fs.readFile(path.join(root, "src/vendor", destination)))
    .digest("hex");
  if (actual !== expected)
    throw new Error("Vendor binary changed: " + destination);
}
// The destination is a fixed child of this project, never a caller-provided path.
await fs.mkdir(dist, { recursive: true });
if ((await fs.lstat(dist)).isSymbolicLink())
  throw new Error("dist cannot be a symlink");
// Recreate only the verified generated directory so renamed sources cannot leave stale scripts.
if (path.dirname(dist) !== root || path.basename(dist) !== "dist")
  throw new Error("Unexpected build destination");
await fs.rm(dist, { recursive: true, force: true });
await fs.mkdir(dist, { recursive: true });
await fs.cp(path.join(root, "src"), dist, {
  recursive: true,
  filter: (source) => !source.endsWith(".ts"),
});
async function sources(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? sources(path.join(directory, entry.name))
          : entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")
            ? [path.join(directory, entry.name)]
            : [],
      ),
    )
  ).flat();
}
const classic = new Set(["content.ts", "page.ts", "youtube-session.ts"]);
const entries = await sources(path.join(root, "src"));
await build({
  entryPoints: entries.filter((file) => !classic.has(path.basename(file))),
  outdir: dist,
  outbase: path.join(root, "src"),
  format: "esm",
  platform: "browser",
  target: "chrome120",
  sourcemap: true,
});
for (const name of classic)
  await build({
    entryPoints: [path.join(root, "src", name)],
    outfile: path.join(dist, name.replace(/\.ts$/, ".js")),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "chrome120",
    sourcemap: true,
  });
await build({
  entryPoints: [path.join(root, "scripts/vendor/sabr-entry.mjs")],
  outfile: path.join(dist, "vendor/sabr.mjs"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome120",
  minify: true,
  legalComments: "inline",
});
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type),
    len = Buffer.alloc(4),
    crc = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([len, name, data, crc]);
}
const pixels = Buffer.alloc(128 * (1 + 128 * 4));
for (let y = 0; y < 128; y++)
  for (let x = 0; x < 128; x++) {
    const p = y * (1 + 128 * 4) + 1 + x * 4;
    const arrow =
      (x >= 56 && x < 72 && y >= 25 && y < 77) ||
      (y >= 63 && y <= 94 && Math.abs(x - 64) < 94 - y);
    const tray =
      (y >= 98 && y < 106 && x >= 30 && x < 98) ||
      (((x >= 30 && x < 38) || (x >= 90 && x < 98)) && y >= 86 && y < 106);
    pixels.set(arrow || tray ? [109, 224, 191, 255] : [16, 21, 27, 255], p);
  }
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(128, 0);
ihdr.writeUInt32BE(128, 4);
ihdr[8] = 8;
ihdr[9] = 6;
await fs.writeFile(
  path.join(dist, "icon.png"),
  Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]),
);
await fs.copyFile(
  path.join(root, "THIRD_PARTY_NOTICES.md"),
  path.join(dist, "THIRD_PARTY_NOTICES.md"),
);
const manifest = JSON.parse(
  await fs.readFile(path.join(dist, "manifest.json"), "utf8"),
);
for (const filename of [
  manifest.background.service_worker,
  manifest.action.default_popup,
  ...manifest.content_scripts.flatMap((s) => s.js),
  "offscreen.html",
  "worker.js",
  "vendor/libav.mjs",
  "vendor/libav.wasm",
])
  await fs.access(path.join(dist, filename));
console.log(
  "Built dist. Vendor checksums verified." +
    (originalPresent
      ? " Verified " + inventory.length + " original files unchanged."
      : ""),
);
