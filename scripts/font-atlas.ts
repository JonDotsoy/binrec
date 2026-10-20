// Rasterizes the glyphs `binrec export` draws videos with into src/video/font.txt.
// Run it again only to change the font, its size or the characters it covers:
//
//   bun scripts/font-atlas.ts [<Regular.ttf> <Bold.ttf>]
//
// Chromium (through playwright-core, like the browser tests) draws every glyph
// of JetBrains Mono that the font has in the ranges below into a cell, and the
// coverage of each pixel (0 to 255) is saved, gzipped and in base64, so the
// bundle can import it as text and needs neither the font nor a browser.
// Block elements and braille are not taken from the font: src/video/render.ts
// draws them so they fill the cell.
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dir, "..");
const fonts = "/usr/share/fonts/truetype/jetbrains-mono";
const [regularPath = join(fonts, "JetBrainsMono-Regular.ttf"), boldPath = join(fonts, "JetBrainsMono-Bold.ttf")] =
  process.argv.slice(2);

/** Font size in px; the cell is as wide as the advance and as tall as the line. */
const FONT_SIZE = 16;

const ranges: [number, number][] = [
  [0x20, 0x7e], // ASCII
  [0xa0, 0x17f], // Latin-1, Latin Extended-A
  [0x370, 0x3ff], // Greek
  [0x400, 0x4ff], // Cyrillic
  [0x2010, 0x205e], // punctuation: dashes, quotes, bullets, ellipsis
  [0x20a0, 0x20bf], // currency
  [0x2190, 0x21ff], // arrows
  [0x2300, 0x23ff], // technical: ⌘ ⏎ ⏵
  [0x2500, 0x257f], // box drawing
  [0x25a0, 0x25ff], // geometric shapes
  [0x2700, 0x27bf], // dingbats: ✓ ✗ ❯
  [0xe0a0, 0xe0d4], // powerline
];

/** Code points in the `cmap` of a TrueType font (formats 4 and 12). */
const codepointsOf = (font: Uint8Array) => {
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
  const tables = view.getUint16(4);
  let cmap = -1;
  for (let i = 0; i < tables; i++) {
    const record = 12 + i * 16;
    if (String.fromCharCode(...font.subarray(record, record + 4)) === "cmap") cmap = view.getUint32(record + 8);
  }
  if (cmap < 0) throw new Error("font-atlas: the font has no cmap table");
  const found = new Set<number>();
  const subtables = view.getUint16(cmap + 2);
  for (let i = 0; i < subtables; i++) {
    const offset = cmap + view.getUint32(cmap + 4 + i * 8 + 4);
    const format = view.getUint16(offset);
    if (format === 4) {
      const segments = view.getUint16(offset + 6) / 2;
      const ends = offset + 14;
      const starts = ends + segments * 2 + 2;
      const deltas = starts + segments * 2;
      const rangeOffsets = deltas + segments * 2;
      for (let s = 0; s < segments; s++) {
        const start = view.getUint16(starts + s * 2);
        const end = view.getUint16(ends + s * 2);
        const delta = view.getUint16(deltas + s * 2);
        const rangeOffset = view.getUint16(rangeOffsets + s * 2);
        for (let code = start; code <= end && code !== 0xffff; code++) {
          const glyph = rangeOffset
            ? view.getUint16(rangeOffsets + s * 2 + rangeOffset + (code - start) * 2)
            : (code + delta) & 0xffff;
          if (glyph) found.add(code);
        }
      }
    } else if (format === 12) {
      const groups = view.getUint32(offset + 12);
      for (let g = 0; g < groups; g++) {
        const group = offset + 16 + g * 12;
        for (let code = view.getUint32(group); code <= view.getUint32(group + 4); code++) found.add(code);
      }
    }
  }
  return found;
};

/** Text of the `name` table entry `id` (like 13, the license), from its Windows record. */
const nameOf = (font: Uint8Array, id: number) => {
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
  for (let i = 0; i < view.getUint16(4); i++) {
    const record = 12 + i * 16;
    if (String.fromCharCode(...font.subarray(record, record + 4)) !== "name") continue;
    const table = view.getUint32(record + 8);
    const strings = table + view.getUint16(table + 4);
    for (let n = 0; n < view.getUint16(table + 2); n++) {
      const entry = table + 6 + n * 12;
      if (view.getUint16(entry) !== 3 || view.getUint16(entry + 6) !== id) continue;
      const start = strings + view.getUint16(entry + 10);
      const bytes = font.subarray(start, start + view.getUint16(entry + 8));
      return new TextDecoder("utf-16be").decode(bytes);
    }
  }
  return "";
};

const regular = new Uint8Array(await Bun.file(regularPath).arrayBuffer());
const bold = new Uint8Array(await Bun.file(boldPath).arrayBuffer());
const inFont = codepointsOf(regular);
const procedural = (code: number) => (code >= 0x2580 && code <= 0x259f) || (code >= 0x2800 && code <= 0x28ff);
const codepoints = ranges
  .flatMap(([start, end]) => Array.from({ length: end - start + 1 }, (_, i) => start + i))
  .filter((code) => inFont.has(code) && !procedural(code));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium" });
const page = await browser.newPage();
const atlas = await page.evaluate(
  async ({ regular, bold, codepoints, size }) => {
    const load = async (name: string, base64: string) => {
      const face = new FontFace(name, `url(data:font/ttf;base64,${base64})`);
      document.fonts.add(await face.load());
    };
    await load("Regular", regular);
    await load("Bold", bold);

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    context.font = `${size}px Regular`;
    const metrics = context.measureText("M");
    const width = Math.round(metrics.width);
    const ascent = Math.ceil(metrics.fontBoundingBoxAscent);
    const height = ascent + Math.ceil(metrics.fontBoundingBoxDescent);
    canvas.width = width;
    canvas.height = height;

    // Box drawing is stretched from the top to the bottom of the cell so lines
    // join up from one row to the next.
    const line = context.measureText("\u2502");
    const lineTop = ascent - line.actualBoundingBoxAscent;
    const lineHeight = line.actualBoundingBoxAscent + line.actualBoundingBoxDescent;
    const draw = (family: string) => {
      const out: number[] = [];
      for (const code of codepoints) {
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.fillStyle = "#000";
        context.fillRect(0, 0, width, height);
        context.fillStyle = "#fff";
        context.font = `${size}px ${family}`;
        context.textBaseline = "alphabetic";
        if (code >= 0x2500 && code <= 0x257f) {
          context.setTransform(1, 0, 0, height / lineHeight, 0, (-lineTop * height) / lineHeight);
        }
        const text = String.fromCodePoint(code);
        context.fillText(text, (width - context.measureText(text).width) / 2, ascent);
        const pixels = context.getImageData(0, 0, width, height).data;
        for (let i = 0; i < pixels.length; i += 4) out.push(pixels[i]!);
      }
      return out;
    };
    return { width, height, baseline: ascent, regular: draw("Regular"), bold: draw("Bold") };
  },
  {
    regular: Buffer.from(regular).toString("base64"),
    bold: Buffer.from(bold).toString("base64"),
    codepoints,
    size: FONT_SIZE,
  },
);
await browser.close();

// Layout: a JSON header line, then the regular glyphs and the bold ones, each
// `width * height` bytes in the order of `codepoints`.
const header = JSON.stringify({
  width: atlas.width,
  height: atlas.height,
  baseline: atlas.baseline,
  codepoints,
});
const body = Buffer.concat([
  Buffer.from(`${header}\n`),
  Buffer.from(Uint8Array.from(atlas.regular)),
  Buffer.from(Uint8Array.from(atlas.bold)),
]);
const out = join(root, "src", "video", "font.txt");
await Bun.write(out, `${Buffer.from(Bun.gzipSync(body, { level: 9 })).toString("base64")}\n`);
console.log(
  `Wrote ${out}: ${codepoints.length} glyphs, cell ${atlas.width}×${atlas.height}, font ${nameOf(regular, 4)}`,
);
console.log(`License of the font: ${nameOf(regular, 13).split("\n")[0]}`);
