import { mkdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export type RecOptions = {
  /**
   * Folder where the `<sessionId>.ndjson` record is written, or `false` to run
   * without recording. Recording is also skipped while `<records>/.disabled` exists.
   */
  records: string | false;
};

export type RecResult = {
  exitCode: number;
  /** Session id, or `null` when nothing was recorded. */
  sessionId: string | null;
  /** Absolute path of the ndjson record, or `null` when nothing was recorded. */
  recordPath: string | null;
};

/** Name of the marker file that turns recording off for a records folder. */
export const DISABLED_MARKER = ".disabled";

const strictDecoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Encodes a chunk for the record: `data` holds the text when the chunk is valid
 * UTF-8 on its own; otherwise `data` is `null` and `data_base64` holds the bytes.
 */
const encodeChunk = (chunk: Uint8Array) => {
  try {
    return { data: strictDecoder.decode(chunk) };
  } catch {
    return { data: null, data_base64: Buffer.from(chunk).toString("base64") };
  }
};

const stamp = () => ({
  timestamp: new Date().toISOString(),
  performance: performance.now(),
});

/**
 * Runs `target` with `args`, passing stdin, stdout and stderr through to the
 * real binary while recording every chunk to `<records>/<sessionId>.ndjson`.
 *
 * Record lines, in order:
 * - `{ type: "command", sessionId, timestamp, performance, command, args }`
 * - `{ type: "stdin" | "stdout" | "stderr", timestamp, performance, data }`, where
 *   `data` is `null` and `data_base64` holds the bytes if the chunk is not valid UTF-8
 * - `{ type: "end", timestamp, performance, exitCode }`
 */
export const rec = async (
  target: string,
  args: string[],
  options: RecOptions,
): Promise<RecResult> => {
  const command = isAbsolute(target) ? target : (Bun.which(target) ?? resolve(target));

  const records = options.records === false ? null : resolve(options.records);
  if (!records || (await Bun.file(join(records, DISABLED_MARKER)).exists())) {
    const child = Bun.spawn([command, ...args], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    return { exitCode: await child.exited, sessionId: null, recordPath: null };
  }

  const sessionId = crypto.randomUUID();
  const recordPath = join(records, `${sessionId}.ndjson`);

  await mkdir(records, { recursive: true });
  const record = Bun.file(recordPath).writer();
  const write = (line: Record<string, unknown>) => {
    record.write(`${JSON.stringify(line)}\n`);
  };

  write({ type: "command", sessionId, ...stamp(), command, args });

  const child = Bun.spawn([command, ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  const forward = async (
    type: "stdout" | "stderr",
    source: ReadableStream<Uint8Array>,
    sink: NodeJS.WriteStream,
  ) => {
    for await (const chunk of source) {
      sink.write(chunk);
      write({ type, ...stamp(), ...encodeChunk(chunk) });
    }
  };

  // Not awaited: on a terminal stdin may never end, and the session is over
  // once the child exits.
  void (async () => {
    try {
      for await (const chunk of process.stdin as AsyncIterable<Uint8Array>) {
        write({ type: "stdin", ...stamp(), ...encodeChunk(chunk) });
        child.stdin.write(chunk);
        await child.stdin.flush();
      }
      await child.stdin.end();
    } catch {
      // The child closed its stdin or already exited.
    }
  })();

  await Promise.all([
    forward("stdout", child.stdout, process.stdout),
    forward("stderr", child.stderr, process.stderr),
  ]);
  const exitCode = await child.exited;

  write({ type: "end", ...stamp(), exitCode });
  await record.end();

  return { exitCode, sessionId, recordPath };
};
