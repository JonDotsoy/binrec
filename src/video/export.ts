import { Terminal } from "@xterm/headless";
import { extname } from "node:path";
import type { Session } from "../sessions.ts";
import { uiSession } from "../ui/server.ts";
import { loadFont } from "./font.ts";
import { Screen } from "./render.ts";

export type VideoFormat = "mp4" | "webm" | "gif";

export const videoFormats: VideoFormat[] = ["mp4", "webm", "gif"];

export type ExportOptions = {
  /** Video format. Defaults to the extension of `output`, or `mp4`. */
  format?: VideoFormat;
  /** How many times faster than recorded the video plays. Defaults to `1`. */
  speed?: number;
  /** Frames per second. Defaults to `30`, or `15` for a GIF. */
  fps?: number;
  /**
   * Longest wait between two outputs, in seconds of the recording: longer ones
   * (a shell waiting for you to type) are cut to it. Defaults to `5`;
   * `Infinity` keeps every wait as recorded.
   */
  maxPause?: number;
  /** Replace `output` when it already exists. Defaults to `false`. */
  overwrite?: boolean;
  /** Path of ffmpeg. Defaults to the `ffmpeg` found in PATH. */
  ffmpeg?: string;
};

export type ExportResult = {
  /** Path of the video written. */
  output: string;
  format: VideoFormat;
  /** Size of the video in pixels. */
  width: number;
  height: number;
  frames: number;
  /** Length of the video in seconds. */
  duration: number;
};

/** The last frame stays on screen this long after the session ends (ms), so it can be read. */
const END_HOLD = 1000;

/** ffmpeg arguments that encode each format, after the input. */
const encoders: Record<VideoFormat, string[]> = {
  mp4: ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-f", "mp4"],
  webm: ["-c:v", "libvpx-vp9", "-crf", "32", "-b:v", "0", "-deadline", "good", "-cpu-used", "4", "-row-mt", "1", "-pix_fmt", "yuv420p", "-f", "webm"],
  // One palette for the whole GIF, without dithering so text stays sharp.
  gif: ["-vf", "split[a][b];[a]palettegen=stats_mode=full[p];[b][p]paletteuse=dither=none", "-loop", "0", "-f", "gif"],
};

/** The format `output` asks for by its extension, or `undefined`. */
export const formatOf = (output: string): VideoFormat | undefined => {
  const extension = extname(output).slice(1).toLowerCase();
  return videoFormats.find((format) => format === extension);
};

const missingFfmpeg = (path?: string) =>
  new Error(
    path
      ? `binrec: ffmpeg was not found at ${path}`
      : "binrec: exporting a video needs ffmpeg, and it was not found in PATH. Install it (like `sudo apt install ffmpeg` or `brew install ffmpeg`) and try again.",
  );

/**
 * Turns a recorded session into a video at `output`: its `stdout` and `stderr`
 * are played into a terminal (xterm.js, the one `play --ui` uses) of the
 * recorded size, every frame is drawn like the page draws it, and ffmpeg, which
 * must be installed, encodes the frames as MP4 (H.264), WebM (VP9) or GIF.
 */
export const exportVideo = async (session: Session, output: string, options: ExportOptions = {}): Promise<ExportResult> => {
  const format = options.format ?? formatOf(output) ?? "mp4";
  if (!videoFormats.includes(format)) throw new Error(`binrec: unknown video format ${format}; use ${videoFormats.join(", ")}`);
  const speed = options.speed ?? 1;
  if (!(speed > 0) || !Number.isFinite(speed)) throw new Error("binrec: the speed of a video must be a number above 0");
  const fps = options.fps ?? (format === "gif" ? 15 : 30);
  if (!(fps > 0) || fps > 120) throw new Error("binrec: fps must be a number above 0, up to 120");
  const maxPause = (options.maxPause ?? 5) * 1000;
  if (!(maxPause >= 0)) throw new Error("binrec: the longest pause must be a number, 0 or more");
  if (!options.overwrite && (await Bun.file(output).exists())) {
    throw new Error(`binrec: ${output} already exists; pass --force to replace it`);
  }
  const ffmpeg = options.ffmpeg ?? Bun.which("ffmpeg");
  if (!ffmpeg) throw missingFfmpeg();

  // The events with their time in the video (ms): waits cut to `maxPause` and divided by `speed`.
  const played = uiSession(session);
  let last = 0;
  let clock = 0;
  const at = (t: number) => {
    clock += Math.min(Math.max(0, t - last), maxPause) / speed;
    last = Math.max(last, t);
    return clock;
  };
  const events = played.events.map((event) => ({ ...event, t: at(event.t) }));
  const end = at(played.duration) + END_HOLD;

  const font = loadFont();
  const sizes = [played, ...events.filter((event) => event.type === "resize")] as { cols: number; rows: number }[];
  const cols = Math.max(...sizes.map((size) => size.cols));
  const rows = Math.max(...sizes.map((size) => size.rows));
  const screen = new Screen(font, cols, rows);
  const term = new Terminal({
    cols: played.cols,
    rows: played.rows,
    scrollback: 0,
    allowProposedApi: true,
    // Without a terminal, a lone `\n` also returns the cursor, like in `play --ui`.
    convertEol: !played.tty,
  });
  // The headless terminal does not say whether the cursor is hidden (DECTCEM), so it is followed here.
  let cursor = true;
  const follow = (show: boolean) => (params: (number | number[])[]) => {
    if (params.includes(25)) cursor = show;
    return false;
  };
  term.parser.registerCsiHandler({ prefix: "?", final: "h" }, follow(true));
  term.parser.registerCsiHandler({ prefix: "?", final: "l" }, follow(false));
  term.parser.registerEscHandler({ final: "c" }, () => {
    cursor = true;
    return false;
  });

  let encoder: Bun.Subprocess<"pipe", "ignore", "pipe">;
  try {
    encoder = Bun.spawn(
      [
        ffmpeg,
        ...["-hide_banner", "-loglevel", "error", "-y"],
        ...["-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${screen.width}x${screen.height}`, "-r", String(fps), "-i", "-"],
        ...encoders[format],
        output,
      ],
      { stdin: "pipe", stdout: "ignore", stderr: "pipe" },
    );
  } catch {
    throw missingFfmpeg(options.ffmpeg);
  }
  const errors = new Response(encoder.stderr).text();
  const failed = async () => {
    const code = await encoder.exited;
    return new Error(`binrec: ffmpeg could not encode ${output} (exit code ${code})${(await errors).trim() ? `:\n${(await errors).trim()}` : ""}`);
  };

  const frames = Math.max(1, Math.ceil((end * fps) / 1000));
  let next = 0;
  try {
    for (let frame = 0; frame < frames; frame++) {
      const time = (frame * 1000) / fps;
      let pending: Uint8Array[] = [];
      const flush = async () => {
        if (pending.length === 0) return;
        const bytes = Buffer.concat(pending);
        pending = [];
        await new Promise<void>((done) => term.write(bytes, done));
      };
      for (; next < events.length && events[next]!.t <= time; next++) {
        const event = events[next]!;
        if (event.type === "resize") {
          await flush();
          term.resize(event.cols, event.rows);
        } else {
          pending.push(Buffer.from(event.data, "base64"));
        }
      }
      await flush();
      screen.draw(term, cursor);
      encoder.stdin.write(screen.frame.slice());
      await encoder.stdin.flush();
    }
    await encoder.stdin.end();
  } catch {
    throw await failed();
  } finally {
    term.dispose();
  }
  if ((await encoder.exited) !== 0) throw await failed();

  return { output, format, width: screen.width, height: screen.height, frames, duration: frames / fps };
};
