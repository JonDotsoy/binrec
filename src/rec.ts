import { mkdir, open } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { writeSessionStats } from "./stats.ts";

export type RecOptions = {
  /** Folder where the `<sessionId>.ndjson` record is written, or `false` to run without recording. */
  records: string | false;
  /** binrec's `config.json`. Recording is skipped while it has `"recording": false`. */
  config?: string;
};

export type Config = {
  /** `false` turns recording off for every shim; shims keep running the real binary. */
  recording?: boolean;
  /**
   * How many sessions of the same command can run nested inside each other
   * (default 10). A session past the limit fails instead of running, which
   * stops a shim that ends up calling itself.
   */
  maxDepth?: number;
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

/** Environment variable with how many binrec sessions the process runs inside. */
export const DEPTH_ENV = "BINREC_DEPTH";
/**
 * Environment variable with how many sessions of `command` the process runs
 * inside, like `BINREC_DEPTH_DATE` for `/usr/bin/date`. Every character of the
 * name other than a letter or digit becomes `_`.
 */
export const commandDepthEnv = (command: string) =>
  `${DEPTH_ENV}_${basename(command).toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
/**
 * Environment variable with the id of the session the process runs inside. A
 * session started from a recorded one (a command run from a recorded shell)
 * saves that id as `parent` on its `command` line.
 */
export const SESSION_ENV = "BINREC_SESSION";
/** Nesting limit of one command used when `config.json` has no `maxDepth`. */
export const DEFAULT_MAX_DEPTH = 10;

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

/** Builds a `stdin`/`stdout`/`stderr` line; `size` is the chunk's length in bytes. */
const chunkLine = (type: "stdin" | "stdout" | "stderr", chunk: Uint8Array) => ({
  type,
  ...stamp(),
  size: chunk.byteLength,
  ...encodeChunk(chunk),
});

type Write = (line: Record<string, unknown>) => void;

/** Called right after the program starts, before any of its output is recorded. */
type Started = (pid: number) => void;

/**
 * Signals binrec passes on to the program, so stopping binrec (`kill`, a closed
 * terminal) stops the program too instead of leaving it running without binrec.
 */
const FORWARDED_SIGNALS = ["SIGTERM", "SIGHUP"] as const;

/**
 * Signals a terminal sends to its whole foreground process group (Ctrl-C, Ctrl-\).
 * With pipes the program already gets them from the terminal, so binrec only
 * keeps running to record the end; on a pseudo terminal it passes them on.
 */
const TERMINAL_SIGNALS = ["SIGINT", "SIGQUIT"] as const;

/**
 * Passes `signals` on to `child` while it runs and records each one as a
 * `signal` line. Returns a function that removes the handlers.
 */
const forwardSignals = (
  child: { kill(signal: NodeJS.Signals): void },
  write: Write,
  { terminal }: { terminal: boolean },
) => {
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of [...FORWARDED_SIGNALS, ...TERMINAL_SIGNALS]) {
    const forward = terminal || (FORWARDED_SIGNALS as readonly string[]).includes(signal);
    const handler = () => {
      write({ type: "signal", ...stamp(), signal });
      if (forward) child.kill(signal);
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
};

/**
 * Runs the command attached to a pseudo terminal, so interactive programs (vim,
 * `docker exec -it`, pagers) see a real TTY. The terminal merges stdout and
 * stderr, so everything the program prints is recorded as `stdout`. Window size
 * changes are forwarded to the program and recorded as `resize` lines.
 */
const recInTerminal = async (
  command: string,
  args: string[],
  env: Record<string, string | undefined>,
  write: Write,
  started: Started,
) => {
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
      write(chunkLine("stdout", chunk));
    },
    exit() {
      closed();
    },
  });

  const onResize = () => {
    const { cols, rows } = size();
    terminal.resize(cols, rows);
    write({ type: "resize", ...stamp(), cols, rows });
  };
  const onInput = (chunk: Uint8Array) => {
    write(chunkLine("stdin", chunk));
    terminal.write(chunk);
  };

  // Raw mode hands every key (Ctrl-C, arrows, Esc) to the program instead of
  // letting the outer terminal act on it.
  stdin.setRawMode(true);

  let stopForwarding = () => {};
  try {
    const child = Bun.spawn([command, ...args], { terminal, env });
    started(child.pid);
    write({ type: "resize", ...stamp(), ...size() });
    stdin.on("data", onInput);
    stdin.resume();
    stdout.on("resize", onResize);
    stopForwarding = forwardSignals(child, write, { terminal: true });
    const exitCode = await child.exited;
    // Output the program wrote just before exiting may still be in the PTY.
    await Promise.race([terminalClosed, Bun.sleep(100)]);
    return exitCode;
  } finally {
    stopForwarding();
    stdout.off("resize", onResize);
    stdin.off("data", onInput);
    stdin.setRawMode(false);
    stdin.pause();
    terminal.close();
  }
};

/** Runs the command with piped stdio, keeping stdout and stderr apart. */
const recInPipes = async (
  command: string,
  args: string[],
  env: Record<string, string | undefined>,
  write: Write,
  started: Started,
) => {
  const child = Bun.spawn([command, ...args], {
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  started(child.pid);
  const stopForwarding = forwardSignals(child, write, { terminal: false });

  const forward = async (
    type: "stdout" | "stderr",
    source: ReadableStream<Uint8Array>,
    sink: NodeJS.WriteStream,
  ) => {
    for await (const chunk of source) {
      sink.write(chunk);
      write(chunkLine(type, chunk));
    }
  };

  // Not awaited: stdin may never end, and the session is over once the child exits.
  void (async () => {
    try {
      for await (const chunk of process.stdin as AsyncIterable<Uint8Array>) {
        write(chunkLine("stdin", chunk));
        child.stdin.write(chunk);
        await child.stdin.flush();
      }
      await child.stdin.end();
    } catch {
      // The child closed its stdin or already exited.
    }
  })();

  try {
    await Promise.all([
      forward("stdout", child.stdout, process.stdout),
      forward("stderr", child.stderr, process.stderr),
    ]);
    return await child.exited;
  } finally {
    stopForwarding();
  }
};

/**
 * Runs `target` with `args`, passing stdin, stdout and stderr through to the
 * real binary while recording every chunk to `<records>/<sessionId>.ndjson`.
 *
 * Record lines, in order:
 * - `{ type: "command", sessionId, timestamp, performance, command, args, pid, parent, depth }`,
 *   where `pid` is the process id of the recorded program, `parent` is the id of the
 *   session it ran inside (`BINREC_SESSION`) or `null`, and `depth` is how many
 *   binrec sessions it ran inside (`BINREC_DEPTH`, `0` when run on its own)
 * - `{ type: "stdin" | "stdout" | "stderr", timestamp, performance, size, data }`, where
 *   `size` is the chunk's length in bytes, and `data` is `null` and `data_base64`
 *   holds the bytes if the chunk is not valid UTF-8
 * - `{ type: "resize", timestamp, performance, cols, rows }` when run on a terminal
 * - `{ type: "signal", timestamp, performance, signal }` when binrec receives SIGTERM,
 *   SIGHUP, SIGINT or SIGQUIT; SIGTERM and SIGHUP are passed on to the program
 * - `{ type: "end", timestamp, performance, exitCode, total }`, where `total` is the
 *   sum of every chunk's `size`
 *
 * After the session, `{ sessionId, command, total }` is written to `<records>/<sessionId>.stats.json`.
 *
 * The program gets `BINREC_DEPTH` (every nested binrec session) and
 * `BINREC_DEPTH_<COMMAND>` (sessions of this command, see `commandDepthEnv`) set
 * to one more than binrec's own. When `BINREC_DEPTH_<COMMAND>` already reached
 * `maxDepth` from `config.json` (10 by default), the program is not run: binrec
 * prints an error and returns exit code 1. `BINREC_DEPTH` has no limit. While
 * the session is recorded, the program also gets `BINREC_SESSION` set to its id.
 *
 * When both stdin and stdout are a terminal, the program runs on a pseudo
 * terminal so interactive programs keep working; otherwise it runs with pipes.
 * On a pseudo terminal SIGINT and SIGQUIT are passed on too; with pipes the
 * program already gets them from the terminal.
 */
export const rec = async (
  target: string,
  args: string[],
  options: RecOptions,
): Promise<RecResult> => {
  const command = isAbsolute(target) ? target : (Bun.which(target) ?? resolve(target));

  const config = options.config === undefined ? {} : await readConfig(options.config);

  // A shim that resolves to itself would start sessions of its command forever;
  // every session counts itself per command so the loop stops at maxDepth.
  // Different commands nested inside each other only add to BINREC_DEPTH.
  const readDepth = (name: string) => Number.parseInt(process.env[name] ?? "", 10) || 0;
  const commandEnv = commandDepthEnv(command);
  const depth = readDepth(DEPTH_ENV);
  const commandDepth = readDepth(commandEnv);
  const maxDepth =
    typeof config.maxDepth === "number" && config.maxDepth > 0 ? config.maxDepth : DEFAULT_MAX_DEPTH;
  if (commandDepth >= maxDepth) {
    console.error(
      `binrec: ${command} not run, ${commandDepth} sessions of ${basename(command)} are already nested (${commandEnv}, maxDepth ${maxDepth}); a shim may be calling itself`,
    );
    return { exitCode: 1, sessionId: null, recordPath: null };
  }
  const env = {
    ...process.env,
    [DEPTH_ENV]: String(depth + 1),
    [commandEnv]: String(commandDepth + 1),
  };

  const records = options.records === false ? null : resolve(options.records);
  const recordingOff =
    !records ||
    config.recording === false ||
    (await Bun.file(join(records, DISABLED_MARKER)).exists());
  if (recordingOff) {
    const child = Bun.spawn([command, ...args], {
      env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    return { exitCode: await child.exited, sessionId: null, recordPath: null };
  }

  const sessionId = crypto.randomUUID();
  const inherited = process.env[SESSION_ENV];
  const parent = inherited && /^[\w-]+$/.test(inherited) ? inherited : null;
  env[SESSION_ENV] = sessionId;
  const recordPath = join(records, `${sessionId}.ndjson`);

  // Records hold everything the program read and printed, so only the user who
  // recorded them can read them: new folders are 0700 and records are 0600.
  await mkdir(records, { recursive: true, mode: RECORDS_DIR_MODE });
  await (await open(recordPath, "wx", RECORD_FILE_MODE)).close();
  const record = Bun.file(recordPath).writer();
  let total = 0;
  const write: Write = (line) => {
    if (typeof line.size === "number") total += line.size;
    record.write(`${JSON.stringify(line)}\n`);
  };

  // The command line goes first, as soon as the program has a pid.
  const started: Started = (pid) => write({ type: "command", sessionId, ...stamp(), command, args, pid, parent, depth });

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const exitCode = interactive
    ? await recInTerminal(command, args, env, write, started)
    : await recInPipes(command, args, env, write, started);

  write({ type: "end", ...stamp(), exitCode, total });
  await record.end();

  try {
    await writeSessionStats(recordPath, { sessionId, command, total });
  } catch {
    // `binrec stats` can still read the total from the record; never fail the command over it.
  }

  return { exitCode, sessionId, recordPath };
};
