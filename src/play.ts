import type { RecordLine, Session } from "./sessions.ts";

/** A stream chunks are written to, like `process.stdout`. */
export type PlayStream = {
  write(chunk: Uint8Array, callback: (error?: Error | null) => void): unknown;
};

export type PlayOptions = {
  /** Where `stdout` chunks are written. Defaults to `process.stdout`. */
  stdout?: PlayStream;
  /** Where `stderr` chunks are written. Defaults to `process.stderr`. */
  stderr?: PlayStream;
  /**
   * How many times faster than recorded to play: `2` halves every wait, and `0`
   * or `Infinity` writes everything at once. Defaults to `1`, the recorded timing.
   */
  speed?: number;
  /**
   * Prefix every line with when it was written: the recorded `timestamp`, the
   * time since the session started and the stream (`stdin`, `stdout` or
   * `stderr`). What the program read (`stdin`) is listed on `stdout`, and so are
   * the session's command line, first, and its exit code, last.
   */
  timestamps?: boolean;
};

/** The bytes of a chunk line, from `data` or, when it is not UTF-8, `data_base64`. */
const chunkBytes = (line: Extract<RecordLine, { data: string | null }>) =>
  line.data !== null ? Buffer.from(line.data) : Buffer.from(line.data_base64 ?? "", "base64");

const decoder = new TextDecoder();

/** Seconds since the session started, like `+1.250s`. */
const elapsed = (ms: number) => `+${(Math.max(0, ms) / 1000).toFixed(3)}s`;

/** `chunk` with every line prefixed by `prefix`, ending with a newline. */
const labelLines = (prefix: string, chunk: Uint8Array) => {
  const lines = decoder.decode(chunk).replace(/\n$/, "").split("\n");
  return Buffer.from(lines.map((line) => `${prefix}${line}\n`).join(""));
};

const showArg = (arg: string) =>
  /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;

const writeTo = (stream: PlayStream, bytes: Uint8Array) =>
  new Promise<void>((resolve, reject) =>
    stream.write(bytes, (error) => (error ? reject(error) : resolve())),
  );

/**
 * Plays a recorded session back: writes its `stdout` and `stderr` chunks again,
 * each one as long after the start as it was recorded (`performance`). `stdin`
 * chunks are not written, since what the program echoed is already in `stdout`.
 * With `timestamps`, every line also shows when and on which stream it was written,
 * and the `stdin` chunks are listed too, as lines on `stdout`.
 */
export const play = async (session: Session, options: PlayOptions = {}) => {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const speed = options.speed ?? 1;
  const realtime = speed > 0 && Number.isFinite(speed);

  const startedAt = session.lines[0]?.performance ?? 0;
  const playStart = performance.now();
  const label = (line: RecordLine, name: string) =>
    `${line.timestamp}  ${elapsed(line.performance - startedAt).padStart(9)}  ${name.padEnd(6)}  `;

  const first = session.lines[0];
  if (options.timestamps && first) {
    const command = [session.command, ...session.args].map(showArg).join(" ");
    await writeTo(stdout, Buffer.from(`${label(first, "$")}${command}\n`));
  }

  for (const line of session.lines) {
    if (line.type !== "stdout" && line.type !== "stderr" && line.type !== "end") {
      if (line.type !== "stdin" || !options.timestamps) continue;
    }
    if (realtime) {
      const wait = (line.performance - startedAt) / speed - (performance.now() - playStart);
      if (wait > 0) await Bun.sleep(wait);
    }
    if (line.type === "end") {
      if (options.timestamps) {
        await writeTo(stdout, Buffer.from(`${label(line, "exit")}${line.exitCode}\n`));
      }
      continue;
    }
    const bytes = chunkBytes(line);
    await writeTo(
      line.type === "stderr" ? stderr : stdout,
      options.timestamps ? labelLines(label(line, line.type), bytes) : bytes,
    );
  }
};
