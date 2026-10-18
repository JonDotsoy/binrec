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
};

/** The bytes of a chunk line, from `data` or, when it is not UTF-8, `data_base64`. */
const chunkBytes = (line: Extract<RecordLine, { data: string | null }>) =>
  line.data !== null ? Buffer.from(line.data) : Buffer.from(line.data_base64 ?? "", "base64");

const writeTo = (stream: PlayStream, bytes: Uint8Array) =>
  new Promise<void>((resolve, reject) =>
    stream.write(bytes, (error) => (error ? reject(error) : resolve())),
  );

/**
 * Plays a recorded session back: writes its `stdout` and `stderr` chunks again,
 * each one as long after the start as it was recorded (`performance`). `stdin`
 * chunks are not written, since what the program echoed is already in `stdout`.
 */
export const play = async (session: Session, options: PlayOptions = {}) => {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const speed = options.speed ?? 1;
  const realtime = speed > 0 && Number.isFinite(speed);

  const startedAt = session.lines[0]?.performance ?? 0;
  const playStart = performance.now();

  for (const line of session.lines) {
    if (line.type !== "stdout" && line.type !== "stderr") continue;
    if (realtime) {
      const wait = (line.performance - startedAt) / speed - (performance.now() - playStart);
      if (wait > 0) await Bun.sleep(wait);
    }
    await writeTo(line.type === "stdout" ? stdout : stderr, chunkBytes(line));
  }
};
