import { mkdir, open } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export type RecOptions = {
  /** Folder where the `<sessionId>.ndjson` record is written, or `false` to run without recording. */
  records: string | false;
  /** binrec's `config.json`. Recording is skipped while it has `"recording": false`. */
  config?: string;
};

export type Config = {
  /** `false` turns recording off for every shim; shims keep running the real binary. */
  recording?: boolean;
};

/** Reads a binrec `config.json`; a missing or unreadable file means the defaults. */
export const readConfig = async (path: string): Promise<Config> => {
  try {
    return await Bun.file(path).json();
  } catch {
    return {};
  }
};

export type RecResult = {
  exitCode: number;
  /** Session id, or `null` when nothing was recorded. */
  sessionId: string | null;
  /** Absolute path of the ndjson record, or `null` when nothing was recorded. */
  recordPath: string | null;
};

/** Marker file older binrec versions used to turn recording off; still honored. */
export const DISABLED_MARKER = ".disabled";

/** Permissions of a records folder binrec creates: only its owner can list or enter it. */
export const RECORDS_DIR_MODE = 0o700;
/** Permissions of every record: only its owner can read or write it. */
export const RECORD_FILE_MODE = 0o600;

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

type Write = (line: Record<string, unknown>) => void;

/**
 * Runs the command attached to a pseudo terminal, so interactive programs (vim,
 * `docker exec -it`, pagers) see a real TTY. The terminal merges stdout and
 * stderr, so everything the program prints is recorded as `stdout`. Window size
 * changes are forwarded to the program and recorded as `resize` lines.
 */
const recInTerminal = async (command: string, args: string[], write: Write) => {
  const stdin = process.stdin;
  const stdout = process.stdout;
  const size = () => ({ cols: stdout.columns || 80, rows: stdout.rows || 24 });

  let closed: () => void;
  const terminalClosed = new Promise<void>((resolve) => (closed = resolve));

  const terminal = new Bun.Terminal({
    ...size(),
    name: process.env.TERM || "xterm-256color",
    data(_terminal, chunk) {
      stdout.write(chunk);
      write({ type: "stdout", ...stamp(), ...encodeChunk(chunk) });
    },
    exit() {
      closed();
    },
  });

  write({ type: "resize", ...stamp(), ...size() });
  const onResize = () => {
    const { cols, rows } = size();
    terminal.resize(cols, rows);
    write({ type: "resize", ...stamp(), cols, rows });
  };
  const onInput = (chunk: Uint8Array) => {
    write({ type: "stdin", ...stamp(), ...encodeChunk(chunk) });
    terminal.write(chunk);
  };

  // Raw mode hands every key (Ctrl-C, arrows, Esc) to the program instead of
  // letting the outer terminal act on it.
  stdin.setRawMode(true);
  stdin.on("data", onInput);
  stdin.resume();
  stdout.on("resize", onResize);

  try {
    const child = Bun.spawn([command, ...args], { terminal });
    const exitCode = await child.exited;
    // Output the program wrote just before exiting may still be in the PTY.
    await Promise.race([terminalClosed, Bun.sleep(100)]);
    return exitCode;
  } finally {
    stdout.off("resize", onResize);
    stdin.off("data", onInput);
    stdin.setRawMode(false);
    stdin.pause();
    terminal.close();
  }
};

/** Runs the command with piped stdio, keeping stdout and stderr apart. */
const recInPipes = async (command: string, args: string[], write: Write) => {
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

  // Not awaited: stdin may never end, and the session is over once the child exits.
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
  return child.exited;
};

/**
 * Runs `target` with `args`, passing stdin, stdout and stderr through to the
 * real binary while recording every chunk to `<records>/<sessionId>.ndjson`.
 *
 * Record lines, in order:
 * - `{ type: "command", sessionId, timestamp, performance, command, args }`
 * - `{ type: "stdin" | "stdout" | "stderr", timestamp, performance, data }`, where
 *   `data` is `null` and `data_base64` holds the bytes if the chunk is not valid UTF-8
 * - `{ type: "resize", timestamp, performance, cols, rows }` when run on a terminal
 * - `{ type: "end", timestamp, performance, exitCode }`
 *
 * When both stdin and stdout are a terminal, the program runs on a pseudo
 * terminal so interactive programs keep working; otherwise it runs with pipes.
 */
export const rec = async (
  target: string,
  args: string[],
  options: RecOptions,
): Promise<RecResult> => {
  const command = isAbsolute(target) ? target : (Bun.which(target) ?? resolve(target));

  const records = options.records === false ? null : resolve(options.records);
  const recordingOff =
    !records ||
    (options.config !== undefined && (await readConfig(options.config)).recording === false) ||
    (await Bun.file(join(records, DISABLED_MARKER)).exists());
  if (recordingOff) {
    const child = Bun.spawn([command, ...args], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    return { exitCode: await child.exited, sessionId: null, recordPath: null };
  }

  const sessionId = crypto.randomUUID();
  const recordPath = join(records, `${sessionId}.ndjson`);

  // Records hold everything the program read and printed, so only the user who
  // recorded them can read them: new folders are 0700 and records are 0600.
  await mkdir(records, { recursive: true, mode: RECORDS_DIR_MODE });
  await (await open(recordPath, "wx", RECORD_FILE_MODE)).close();
  const record = Bun.file(recordPath).writer();
  const write: Write = (line) => {
    record.write(`${JSON.stringify(line)}\n`);
  };

  write({ type: "command", sessionId, ...stamp(), command, args });

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const exitCode = interactive
    ? await recInTerminal(command, args, write)
    : await recInPipes(command, args, write);

  write({ type: "end", ...stamp(), exitCode });
  await record.end();

  return { exitCode, sessionId, recordPath };
};
