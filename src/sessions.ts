import { readdir, stat } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";

export type RecordLine =
  | {
      type: "command";
      sessionId: string;
      timestamp: string;
      performance: number;
      command: string;
      args: string[];
      /** Process id of the recorded program. Missing in older records. */
      pid?: number;
    }
  | {
      type: "stdin" | "stdout" | "stderr";
      timestamp: string;
      performance: number;
      /** Length of the chunk in bytes. Missing in older records. */
      size?: number;
      /** The chunk as text, or `null` when it is not valid UTF-8. */
      data: string | null;
      /** The chunk's bytes in base64, present only when `data` is `null`. */
      data_base64?: string;
    }
  | {
      /** Window size of the terminal, only in sessions recorded on a terminal. */
      type: "resize";
      timestamp: string;
      performance: number;
      cols: number;
      rows: number;
    }
  | {
      /** A signal binrec received while the program ran. */
      type: "signal";
      timestamp: string;
      performance: number;
      signal: string;
    }
  | {
      type: "end";
      timestamp: string;
      performance: number;
      exitCode: number;
      /** Sum of every chunk's `size`. Missing in older records. */
      total?: number;
    };

export type SessionInit = {
  /** Exit code of the recorded program, or `null` if the session has not ended. */
  exitCode: number | null;
  /** Bytes the program wrote to stdout. */
  stdout: ReadableStream<Uint8Array>;
  /** Bytes the program wrote to stderr. */
  stderr: ReadableStream<Uint8Array>;
  /** Bytes the program read from stdin. */
  stdin: ReadableStream<Uint8Array>;
  /** Absolute path of the recorded binary. */
  command: string;
  args: string[];
  /** Session id. */
  sid: string;
  /** Every line of the record, in order. */
  lines?: RecordLine[];
};

/** One recorded run of a command. */
export class Session {
  readonly exitCode: number | null;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly stdin: ReadableStream<Uint8Array>;
  readonly command: string;
  readonly args: string[];
  readonly sid: string;
  /** Every line of the record, in order; empty for a session not read from a record. */
  readonly lines: RecordLine[];

  constructor(init: SessionInit) {
    this.exitCode = init.exitCode;
    this.stdout = init.stdout;
    this.stderr = init.stderr;
    this.stdin = init.stdin;
    this.command = init.command;
    this.args = init.args;
    this.sid = init.sid;
    this.lines = init.lines ?? [];
  }

  /**
   * Reads a session from its ndjson record. Throws when the record does not
   * start with a `command` line.
   */
  static async fromNDJSON(buff: ReadableStream<Uint8Array>): Promise<Session> {
    const lines = parseRecord(await new Response(buff).text());
    const first = lines[0];
    if (first?.type !== "command") throw new Error("binrec: the record has no command line");

    const end = lines.findLast((line) => line.type === "end");
    const chunks = { stdin: [] as Uint8Array[], stdout: [] as Uint8Array[], stderr: [] as Uint8Array[] };
    for (const line of lines) {
      if (line.type === "stdin" || line.type === "stdout" || line.type === "stderr") {
        chunks[line.type].push(chunkBytes(line));
      }
    }

    return new Session({
      exitCode: end?.type === "end" ? end.exitCode : null,
      stdout: new Blob(chunks.stdout).stream(),
      stderr: new Blob(chunks.stderr).stream(),
      stdin: new Blob(chunks.stdin).stream(),
      command: first.command,
      args: first.args,
      sid: first.sessionId,
      lines,
    });
  }
}

type ChunkLine = Extract<RecordLine, { type: "stdin" | "stdout" | "stderr" }>;

const chunkBytes = (line: ChunkLine) =>
  line.data !== null
    ? new TextEncoder().encode(line.data)
    : new Uint8Array(Buffer.from(line.data_base64 ?? "", "base64"));

const parseRecord = (text: string) =>
  text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RecordLine);

/** What the stats need from a record without turning it into a `Session`. */
export type RecordSummary = {
  sessionId: string;
  command: string;
  exitCode: number | null;
  /**
   * Bytes read and written in the session: `total` from the `end` line, or the
   * sum of the chunks when the record has no `total` (unfinished or older records).
   */
  total: number;
};

/** Size of a chunk line in bytes, worked out from its data when `size` is missing. */
const chunkSize = (line: RecordLine) => {
  if (line.type !== "stdin" && line.type !== "stdout" && line.type !== "stderr") return 0;
  if (typeof line.size === "number") return line.size;
  if (line.data !== null) return Buffer.byteLength(line.data);
  return Buffer.from(line.data_base64 ?? "", "base64").byteLength;
};

const sumChunks = (lines: RecordLine[]) =>
  lines.reduce((sum, line) => sum + chunkSize(line), 0);

/** Reads one ndjson record, or returns `null` when it does not start with a `command` line. */
export const readRecord = async (recordPath: string): Promise<RecordSummary | null> => {
  const lines = parseRecord(await Bun.file(recordPath).text());

  const first = lines[0];
  if (first?.type !== "command") return null;

  const end = lines.findLast((line) => line.type === "end");
  const total =
    end?.type === "end" && typeof end.total === "number" ? end.total : sumChunks(lines);

  return {
    sessionId: first.sessionId,
    command: first.command,
    exitCode: end?.type === "end" ? end.exitCode : null,
    total,
  };
};

/** True when `command` (a name like `date` or an absolute path) is the recorded binary. */
const matches = (session: Session, command: string) =>
  isAbsolute(command)
    ? session.command === resolve(command)
    : basename(session.command) === command;

const startedAt = (session: Session) => session.lines[0]?.timestamp ?? "";

/** Lists every recorded session in `records`, or only those of `command`, oldest first. */
export const sessions = async (records: string, command?: string): Promise<Session[]> => {
  let files: string[];
  try {
    files = (await readdir(records)).filter((file) => file.endsWith(".ndjson"));
  } catch {
    return [];
  }

  const found = await Promise.all(
    files.map(async (file) => {
      const recordPath = join(records, file);
      const session = await Session.fromNDJSON(Bun.file(recordPath).stream()).catch(
        () => null, // unreadable record
      );
      if (!session || (command !== undefined && !matches(session, command))) return null;
      return { session, timestamp: startedAt(session), mtime: (await stat(recordPath)).mtimeMs };
    }),
  );

  return found
    .filter((item) => item !== null)
    .sort(
      (a, b) =>
        a.timestamp.localeCompare(b.timestamp) || a.mtime - b.mtime,
    )
    .map((item) => item.session);
};

/** Returns the most recent recorded session of `command`, or `null` if there is none. */
export const lastSession = async (records: string, command: string) =>
  (await sessions(records, command)).at(-1) ?? null;
