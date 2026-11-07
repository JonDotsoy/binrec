// binrec export: a recorded session turned into a video by ffmpeg. The checks
// read the videos back with ffprobe and ffmpeg, so they need both installed.
import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { $ } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { binrec as lib, type Binrec, type Session } from "../index.ts";

const binrec = new URL("../bin/binrec.ts", import.meta.url).pathname;
const hasFfmpeg = Boolean(Bun.which("ffmpeg") && Bun.which("ffprobe"));

let binrecHome: string;
let out: string;
let b: Binrec;
let env: Record<string, string | undefined>;
/** Prints green, then waits 2 s and prints red. */
let colors: Session;

beforeAll(async () => {
  binrecHome = await mkdtemp(join(tmpdir(), "binrec-export-"));
  out = join(binrecHome, "out");
  await $`mkdir -p ${out}`;
  b = lib.create({ path: join(binrecHome, "bin") });
  const { BINREC_SESSION: _, ...rest } = process.env;
  env = { ...rest, BINREC_HOME: binrecHome };
  const script = String.raw`printf '\033[1;32mGREEN\033[0m\n'; sleep 2; printf '\033[41m    \033[0m\n'`;
  await $`bun ${binrec} rec sh -c ${script}`.env(env).quiet();
  colors = (await b.sessions())[0]!;
});

afterAll(async () => {
  await rm(binrecHome, { recursive: true, force: true });
});

/** Format, codec, size and length of a video, from ffprobe. */
const probe = async (file: string) => {
  const info = await $`ffprobe -v error -show_entries format=format_name,duration:stream=codec_name,width,height -of json ${file}`.json();
  return {
    format: info.format.format_name as string,
    codec: info.streams[0].codec_name as string,
    width: info.streams[0].width as number,
    height: info.streams[0].height as number,
    duration: Number(info.format.duration),
  };
};

/** The last frame of a video as RGB bytes. */
const lastFrame = async (file: string) =>
  new Uint8Array(await $`ffmpeg -v error -sseof -0.3 -i ${file} -update 1 -f rawvideo -pix_fmt rgb24 -`.arrayBuffer());

describe.skipIf(!hasFfmpeg)("with ffmpeg", () => {
  test("exports MP4, WebM and GIF, picking the format from the extension", async () => {
    const expected = { mp4: ["mp4", "h264"], webm: ["webm", "vp9"], gif: ["gif", "gif"] } as const;
    for (const [extension, [format, codec]] of Object.entries(expected)) {
      const file = join(out, `colors.${extension}`);
      const result = await $`bun ${binrec} export -o ${file} ${colors.sessionId.slice(0, 8)}`.env(env).nothrow().quiet();
      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toBe(`Exported ${file}: ${extension}, 820×524, ${result.stdout.toString().match(/[\d.]+ s/)![0]}\n`);
      const info = await probe(file);
      expect(info.format).toContain(format);
      expect(info).toMatchObject({ codec, width: 820, height: 524 });
      // 2 s of recording plus the second the last frame is held.
      expect(info.duration).toBeGreaterThan(2.5);
      expect(info.duration).toBeLessThan(4.5);
    }
  }, 60000);

  test("draws the terminal: colored text and backgrounds, on black", async () => {
    const file = join(out, "frame.gif");
    await b.exportVideo(colors.sessionId, file);
    const frame = await lastFrame(file);
    const width = 820;
    const pixel = (x: number, y: number) => [...frame.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)];
    const inCells = (col0: number, col1: number, row: number) => {
      const found: number[][] = [];
      for (let y = 10 + row * 21; y < 10 + (row + 1) * 21; y++) {
        for (let x = 10 + col0 * 10; x < 10 + col1 * 10; x++) found.push(pixel(x, y));
      }
      return found;
    };
    // Bold green is drawn in bright green (#8ae234), like xterm.js.
    expect(inCells(0, 5, 0).some(([r, g, b]) => g! > 180 && r! < 170 && b! < 90)).toBe(true);
    // Four cells with a red background (#cc0000) on the second row.
    const red = inCells(0, 4, 1);
    expect(red.filter(([r, g, b]) => r! > 180 && g! < 40 && b! < 40).length).toBeGreaterThan(red.length * 0.9);
    // The padding and the empty rows stay black.
    expect(pixel(2, 2)).toEqual([0, 0, 0]);
    expect(pixel(400, 400)).toEqual([0, 0, 0]);
  }, 30000);

  test("--max-pause cuts long waits and --speed plays faster", async () => {
    const paused = join(out, "paused.mp4");
    await $`bun ${binrec} export --max-pause 0.5 -o ${paused} ${colors.sessionId}`.env(env).quiet();
    expect((await probe(paused)).duration).toBeLessThan(2);

    const fast = join(out, "fast.mp4");
    await $`bun ${binrec} export --speed 4 -o ${fast} ${colors.sessionId}`.env(env).quiet();
    expect((await probe(fast)).duration).toBeLessThan(2);
  }, 30000);

  test("--format wins over the extension, and without --output the video is named after the id", async () => {
    const file = join(out, "colors.video");
    await $`bun ${binrec} export --format webm -o ${file} ${colors.sessionId}`.env(env).quiet();
    expect((await probe(file)).codec).toBe("vp9");

    const result = await $`bun ${binrec} export --format gif --fps 10 ${colors.sessionId}`.env(env).cwd(out).quiet();
    const named = join(out, `binrec-${colors.sessionId.slice(0, 8)}.gif`);
    expect(result.stdout.toString()).toStartWith(`Exported binrec-${colors.sessionId.slice(0, 8)}.gif: gif`);
    expect((await probe(named)).codec).toBe("gif");
  }, 30000);

  test("does not replace a file unless --force is passed", async () => {
    const file = join(out, "exists.mp4");
    await Bun.write(file, "keep me");
    const refused = await $`bun ${binrec} export -o ${file} ${colors.sessionId}`.env(env).nothrow().quiet();
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr.toString()).toBe(`binrec: ${file} already exists; pass --force to replace it\n`);
    expect(await Bun.file(file).text()).toBe("keep me");

    const forced = await $`bun ${binrec} export --force -o ${file} ${colors.sessionId}`.env(env).nothrow().quiet();
    expect(forced.exitCode).toBe(0);
    expect((await probe(file)).codec).toBe("h264");
  }, 30000);

  test("plays a session recorded without a terminal with \\n returning the cursor, like play --ui", async () => {
    await $`bun ${binrec} rec sh -c ${"printf 'a\\nb\\n'"}`.env(env).quiet();
    const session = (await b.sessions()).at(-1)!;
    const file = join(out, "lines.gif");
    await b.exportVideo(session.sessionId, file);
    const frame = await lastFrame(file);
    // "b" starts in the first column of the second row: some pixel of that cell is lit.
    let lit = false;
    for (let y = 31; y < 52; y++) for (let x = 10; x < 20; x++) lit ||= frame[(y * 820 + x) * 3]! > 128;
    expect(lit).toBe(true);
  }, 30000);
});

test("says ffmpeg is needed when it is not in PATH", async () => {
  const file = join(binrecHome, "none.mp4");
  const result = await $`bun ${binrec} export -o ${file} ${colors.sessionId}`
    .env({ ...env, PATH: dirname(process.execPath) })
    .nothrow()
    .quiet();
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("exporting a video needs ffmpeg, and it was not found in PATH");
  expect(await Bun.file(file).exists()).toBe(false);
});

test("a wrong ffmpeg path, an unknown session or bad options fail with a message", async () => {
  await expect(b.exportVideo(colors.sessionId, join(binrecHome, "x.mp4"), { ffmpeg: "/nowhere/ffmpeg" })).rejects.toThrow(
    "binrec: ffmpeg was not found at /nowhere/ffmpeg",
  );
  await expect(b.exportVideo("ffffffff", join(binrecHome, "x.mp4"))).rejects.toThrow("binrec: no recorded session ffffffff");

  const cases: [string[], string][] = [
    [["--format", "avi", colors.sessionId], "binrec: --format must be one of mp4, webm, gif"],
    [["--speed", "0", colors.sessionId], "binrec: --speed must be a number above 0"],
    [["--fps", "abc", colors.sessionId], "binrec: --fps must be a number"],
    [["--bogus", colors.sessionId], "binrec: unknown option --bogus for export"],
  ];
  for (const [args, message] of cases) {
    const result = await $`bun ${binrec} export ${args}`.env(env).nothrow().quiet();
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toStartWith(message);
  }
  const usage = await $`bun ${binrec} export`.env(env).nothrow().quiet();
  expect(usage.exitCode).toBe(1);
  expect(usage.stderr.toString()).toStartWith("Usage: binrec export");
});
