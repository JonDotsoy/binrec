import { mkdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export type RecOptions = {
  /** Folder where the `<sessionId>.ndjson` record is written. */
  records: string;
};

export type RecResult = {
  sessionId: string;
  exitCode: number;
  /** Absolute path of the ndjson record for this session. */
  recordPath: string;
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
 * - `{ type: "stdin" | "stdout" | "stderr", timestamp, performance, data }`
 * - `{ type: "end", timestamp, performance, exitCode }`
 */
export const rec = async (
  target: string,
  args: string[],
  options: RecOptions,
): Promise<RecResult> => {
  const sessionId = crypto.randomUUID();
  const records = resolve(options.records);
  const recordPath = join(records, `${sessionId}.ndjson`);
  const command = isAbsolute(target) ? target : (Bun.which(target) ?? resolve(target));

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
    const decoder = new TextDecoder();
    for await (const chunk of source) {
      sink.write(chunk);
      write({ type, ...stamp(), data: decoder.decode(chunk, { stream: true }) });
    }
  };

  // Not awaited: on a terminal stdin may never end, and the session is over
  // once the child exits.
  void (async () => {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of process.stdin as AsyncIterable<Uint8Array>) {
        write({ type: "stdin", ...stamp(), data: decoder.decode(chunk, { stream: true }) });
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

  return { sessionId, exitCode, recordPath };
};
