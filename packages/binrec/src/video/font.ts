/// <reference path="../ui/assets.d.ts" />
// Glyphs of JetBrains Mono (SIL Open Font License 1.1, see FONT-LICENSE.txt)
// rasterized by scripts/font-atlas.ts. Bundled as text so dist/binrec.js keeps it.
import atlas from "./font.txt" with { type: "text" };

/** Coverage of every pixel of a cell, 0 (background) to 255 (foreground), row by row. */
export type Glyph = Uint8Array;

export type Font = {
  /** Size of a cell in pixels. */
  width: number;
  height: number;
  /** Row of the baseline, where underlines go below. */
  baseline: number;
  regular: Map<number, Glyph>;
  bold: Map<number, Glyph>;
};

/** A cell-sized glyph where `paint(x, y)` gives the coverage of each pixel. */
const drawn = (width: number, height: number, paint: (x: number, y: number) => number) => {
  const glyph = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) glyph[y * width + x] = paint(x, y);
  return glyph;
};

/**
 * Block elements (U+2580–U+259F) and braille (U+2800–U+28FF), drawn to fill the
 * cell so bars, shades and spinners join up from one cell to the next.
 */
const drawnGlyphs = (width: number, height: number) => {
  const glyphs = new Map<number, Glyph>();
  const rect = (x0: number, y0: number, x1: number, y1: number, value = 255) =>
    drawn(width, height, (x, y) =>
      x >= Math.round(x0 * width) && x < Math.round(x1 * width) && y >= Math.round(y0 * height) && y < Math.round(y1 * height)
        ? value
        : 0,
    );
  glyphs.set(0x2580, rect(0, 0, 1, 0.5));
  for (let eighths = 1; eighths <= 8; eighths++) glyphs.set(0x2580 + eighths, rect(0, 1 - eighths / 8, 1, 1));
  for (let eighths = 7; eighths >= 1; eighths--) glyphs.set(0x2589 + (7 - eighths), rect(0, 0, eighths / 8, 1));
  glyphs.set(0x2590, rect(0.5, 0, 1, 1));
  glyphs.set(0x2591, rect(0, 0, 1, 1, 64));
  glyphs.set(0x2592, rect(0, 0, 1, 1, 128));
  glyphs.set(0x2593, rect(0, 0, 1, 1, 192));
  glyphs.set(0x2594, rect(0, 0, 1, 1 / 8));
  glyphs.set(0x2595, rect(7 / 8, 0, 1, 1));
  // Quadrants, as [upper left, upper right, lower left, lower right].
  const quadrants: Record<number, number[]> = {
    0x2596: [0, 0, 1, 0], 0x2597: [0, 0, 0, 1], 0x2598: [1, 0, 0, 0], 0x2599: [1, 0, 1, 1],
    0x259a: [1, 0, 0, 1], 0x259b: [1, 1, 1, 0], 0x259c: [1, 1, 0, 1], 0x259d: [0, 1, 0, 0],
    0x259e: [0, 1, 1, 0], 0x259f: [0, 1, 1, 1],
  };
  for (const [code, [ul, ur, ll, lr]] of Object.entries(quadrants)) {
    const halfX = Math.round(width / 2);
    const halfY = Math.round(height / 2);
    glyphs.set(
      Number(code),
      drawn(width, height, (x, y) => ((y < halfY ? (x < halfX ? ul : ur) : x < halfX ? ll : lr) ? 255 : 0)),
    );
  }
  // Braille: dots 1–3 and 7 down the left column, 4–6 and 8 down the right one.
  const dots = [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2], [0, 3], [1, 3]] as const;
  const size = Math.max(2, Math.round(width / 5));
  for (let bits = 0; bits < 256; bits++) {
    glyphs.set(
      0x2800 + bits,
      drawn(width, height, (x, y) =>
        dots.some(([column, row], dot) => {
          if (!(bits & (1 << dot))) return false;
          const left = Math.round(((column * 2 + 1) * width) / 4 - size / 2);
          const top = Math.round(((row * 2 + 1) * height) / 8 - size / 2);
          return x >= left && x < left + size && y >= top && y < top + size;
        })
          ? 255
          : 0,
      ),
    );
  }
  return glyphs;
};

let font: Font | undefined;

/** The font videos are drawn with, read from the bundled atlas the first time it is needed. */
export const loadFont = (): Font => {
  if (font) return font;
  const bytes = Bun.gunzipSync(Buffer.from(atlas, "base64"));
  const newline = bytes.indexOf(10);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(0, newline))) as {
    width: number;
    height: number;
    baseline: number;
    codepoints: number[];
  };
  const { width, height, baseline, codepoints } = header;
  const size = width * height;
  const glyphsAt = (start: number) =>
    new Map<number, Glyph>(codepoints.map((code, index) => [code, bytes.subarray(start + index * size, start + (index + 1) * size)]));
  const regular = glyphsAt(newline + 1);
  const bold = glyphsAt(newline + 1 + codepoints.length * size);
  for (const [code, glyph] of drawnGlyphs(width, height)) {
    regular.set(code, glyph);
    bold.set(code, glyph);
  }
  font = { width, height, baseline, regular, bold };
  return font;
};
