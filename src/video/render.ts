import type { IBufferCell, Terminal } from "@xterm/headless";
import type { Font } from "./font.ts";

/** Pixels around the terminal, like the padding of the `play --ui` page. */
export const PADDING = 10;

const DEFAULT_FG = 0xffffff;
const DEFAULT_BG = 0x000000;

/** The 256 colors of xterm.js's default theme: its 16 ANSI colors, the 6×6×6 cube and the grays. */
const PALETTE = (() => {
  const colors = [
    0x2e3436, 0xcc0000, 0x4e9a06, 0xc4a000, 0x3465a4, 0x75507b, 0x06989a, 0xd3d7cf,
    0x555753, 0xef2929, 0x8ae234, 0xfce94f, 0x729fcf, 0xad7fa8, 0x34e2e2, 0xeeeeec,
  ];
  const steps = [0, 95, 135, 175, 215, 255];
  for (let i = 0; i < 216; i++) {
    colors.push((steps[Math.floor(i / 36)]! << 16) | (steps[Math.floor(i / 6) % 6]! << 8) | steps[i % 6]!);
  }
  for (let i = 0; i < 24; i++) {
    const gray = 8 + i * 10;
    colors.push((gray << 16) | (gray << 8) | gray);
  }
  return colors;
})();

const BOLD = 1;
const UNDERLINE = 2;
const STRIKETHROUGH = 4;
const OVERLINE = 8;
const WIDE = 16;
const CURSOR = 32;

/**
 * Draws what a headless xterm.js terminal shows into an RGB frame (3 bytes per
 * pixel), like the terminal of the `play --ui` page: black background, white
 * text, xterm.js's colors, bold text in bright colors and an outlined cursor.
 * The frame has room for `cols` × `rows` cells; a smaller terminal is drawn in
 * its top left corner. Only the cells that changed since the last frame are drawn.
 */
export class Screen {
  readonly width: number;
  readonly height: number;
  readonly frame: Uint8Array;
  /** What every cell showed in the last frame: code point, colors and flags, -1 when never drawn. */
  private readonly drawnAs: Int32Array;

  constructor(
    private readonly font: Font,
    private readonly cols: number,
    private readonly rows: number,
  ) {
    // H.264 and VP9 with yuv420p need an even width and height.
    this.width = (cols * font.width + PADDING * 2 + 1) & ~1;
    this.height = (rows * font.height + PADDING * 2 + 1) & ~1;
    this.frame = new Uint8Array(this.width * this.height * 3);
    this.drawnAs = new Int32Array(cols * rows * 4).fill(-1);
  }

  /** Draws `term` into `frame`; with `cursor`, the cursor is outlined where it is. */
  draw(term: Terminal, cursor: boolean) {
    const buffer = term.buffer.active;
    const cursorRow = buffer.baseY + buffer.cursorY - buffer.viewportY;
    let cell: IBufferCell | undefined;
    for (let row = 0; row < this.rows; row++) {
      const line = row < term.rows ? buffer.getLine(buffer.viewportY + row) : undefined;
      for (let col = 0; col < this.cols; col++) {
        let code = 0;
        let fg = DEFAULT_FG;
        let bg = DEFAULT_BG;
        let flags = 0;
        cell = col < term.cols ? line?.getCell(col, cell) : undefined;
        if (cell) {
          if (cell.getWidth() === 0) continue; // the right half of a wide character
          if (cell.getWidth() === 2) flags |= WIDE;
          code = cell.getChars().codePointAt(0) ?? 0;
          [fg, bg] = colorsOf(cell);
          if (cell.isBold()) flags |= BOLD;
          if (cell.isUnderline()) flags |= UNDERLINE;
          if (cell.isStrikethrough()) flags |= STRIKETHROUGH;
          if (cell.isOverline()) flags |= OVERLINE;
          if (cell.isInvisible()) code = 0;
        }
        if (cursor && row === cursorRow && col === buffer.cursorX && row < term.rows) flags |= CURSOR;
        const at = (row * this.cols + col) * 4;
        const before = this.drawnAs;
        if (before[at] === code && before[at + 1] === fg && before[at + 2] === bg && before[at + 3] === flags) continue;
        before[at] = code;
        before[at + 1] = fg;
        before[at + 2] = bg;
        before[at + 3] = flags;
        this.drawCell(col, row, code, fg, bg, flags);
      }
    }
  }

  private drawCell(col: number, row: number, code: number, fg: number, bg: number, flags: number) {
    const { width, height, baseline } = this.font;
    const span = flags & WIDE && col + 1 < this.cols ? 2 : 1;
    const left = PADDING + col * width;
    const top = PADDING + row * height;
    const cellWidth = width * span;
    const glyph = code > 0x20 ? (flags & BOLD ? this.font.bold : this.font.regular).get(code) : undefined;
    const coverage = (x: number, y: number) => {
      if (flags & UNDERLINE && y === Math.min(height - 1, baseline + 2)) return 255;
      if (flags & STRIKETHROUGH && y === Math.round(height / 2)) return 255;
      if (flags & OVERLINE && y === 0) return 255;
      if (flags & CURSOR && (x === 0 || y === 0 || x === cellWidth - 1 || y === height - 1)) return 255;
      if (glyph) {
        // A wide character found in the font is drawn in the middle of its two cells.
        const gx = x - (span === 2 ? Math.floor(width / 2) : 0);
        return gx >= 0 && gx < width ? glyph[y * width + gx]! : 0;
      }
      // A character the font lacks shows as an empty box.
      if (code > 0x20 && x >= 1 && x <= cellWidth - 2 && y >= 3 && y <= height - 4) {
        return x === 1 || x === cellWidth - 2 || y === 3 || y === height - 4 ? 160 : 0;
      }
      return 0;
    };
    this.paint(left, top, cellWidth, height, fg, bg, coverage);
  }

  private paint(
    left: number,
    top: number,
    width: number,
    height: number,
    fg: number,
    bg: number,
    coverage: (x: number, y: number) => number,
  ) {
    const fr = fg >> 16, fgG = (fg >> 8) & 0xff, fb = fg & 0xff;
    const br = bg >> 16, bgG = (bg >> 8) & 0xff, bb = bg & 0xff;
    for (let y = 0; y < height; y++) {
      let at = ((top + y) * this.width + left) * 3;
      for (let x = 0; x < width; x++, at += 3) {
        const alpha = coverage(x, y);
        this.frame[at] = br + Math.round(((fr - br) * alpha) / 255);
        this.frame[at + 1] = bgG + Math.round(((fgG - bgG) * alpha) / 255);
        this.frame[at + 2] = bb + Math.round(((fb - bb) * alpha) / 255);
      }
    }
  }
}

/** Foreground and background of a cell as 0xRRGGBB, after bold, dim and inverse. */
const colorsOf = (cell: IBufferCell): [number, number] => {
  let fg = DEFAULT_FG;
  if (cell.isFgRGB()) fg = cell.getFgColor();
  else if (cell.isFgPalette()) {
    const index = cell.getFgColor();
    fg = PALETTE[index < 8 && cell.isBold() ? index + 8 : index] ?? DEFAULT_FG;
  }
  let bg = DEFAULT_BG;
  if (cell.isBgRGB()) bg = cell.getBgColor();
  else if (cell.isBgPalette()) bg = PALETTE[cell.getBgColor()] ?? DEFAULT_BG;
  if (cell.isInverse()) [fg, bg] = [bg, fg];
  if (cell.isDim()) fg = mix(fg, bg);
  return [fg, bg];
};

/** The color halfway between `a` and `b`. */
const mix = (a: number, b: number) =>
  (((((a >> 16) + (b >> 16)) >> 1) << 16) |
    (((((a >> 8) & 0xff) + ((b >> 8) & 0xff)) >> 1) << 8) |
    (((a & 0xff) + (b & 0xff)) >> 1));
