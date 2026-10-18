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
      type: "end";
      timestamp: string;
      performance: number;
      exitCode: number;
      /** Sum of every chunk's `size`. Missing in older records. */
      total?: number;
    };

export type Session = {
  sessionId: string;
  /** Absolute path of the recorded binary. */
  command: string;
  args: string[];
  /** When the session started (ISO 8601). */
  timestamp: string;
  /** Exit code from the `end` line, or `null` if the session has not ended. */
  exitCode: number | null;
  /**
   * Bytes read and written in the session: `total` from the `end` line, or the
   * sum of the chunks when the record has no `total` (unfinished or older records).
   */
  total: number;
  /** Absolute path of the ndjson record. */
  recordPath: string;
  /** Every line of the record, in order. */
  lines: RecordLine[];
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

const readSession = async (recordPath: string): Promise<Session | null> => {
  const lines = (await Bun.file(recordPath).text())
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RecordLine);

  const first = lines[0];
  if (first?.type !== "command") return null;

  const end = lines.findLast((line) => line.type === "end");
  const total =
    end?.type === "end" && typeof end.total === "number" ? end.total : sumChunks(lines);

  return {
    sessionId: first.sessionId,
    command: first.command,
    args: first.args,
    timestamp: first.timestamp,
    exitCode: end?.type === "end" ? end.exitCode : null,
    total,
    recordPath,
    lines,
  };
};

/** True when `command` (a name like `date` or an absolute path) is the recorded binary. */
const matches = (session: Session, command: string) =>
  isAbsolute(command)
    ? session.command === resolve(command)
    : basename(session.command) === command;

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
      const session = await readSession(recordPath).catch(() => null); // unreadable record
      if (!session || (command !== undefined && !matches(session, command))) return null;
      return { session, mtime: (await stat(recordPath)).mtimeMs };
    }),
  );

  return found
    .filter((item) => item !== null)
    .sort(
      (a, b) =>
        a.session.timestamp.localeCompare(b.session.timestamp) || a.mtime - b.mtime,
    )
    .map((item) => item.session);
};

/** Returns the most recent recorded session of `command`, or `null` if there is none. */
export const lastSession = async (records: string, command: string) =>
  (await sessions(records, command)).at(-1) ?? null;

export type CommandStats = {
  /** Absolute path of the recorded binary. */
  command: string;
  /** Number of recorded sessions of the command. */
  sessions: number;
  /** Bytes read and written across those sessions. */
  total: number;
};

export type Stats = {
  /** Number of recorded sessions. */
  sessions: number;
  /** Bytes read and written across every session. */
  total: number;
  /** One entry per recorded binary, the one that consumed the most bytes first. */
  commands: CommandStats[];
};

/** Adds up the bytes every recorded session consumed, overall and per command. */
export const stats = async (records: string): Promise<Stats> => {
  const all = await sessions(records);
  const byCommand = new Map<string, CommandStats>();
  for (const session of all) {
    const entry = byCommand.get(session.command) ?? {
      command: session.command,
      sessions: 0,
      total: 0,
    };
    entry.sessions += 1;
    entry.total += session.total;
    byCommand.set(session.command, entry);
  }

  return {
    sessions: all.length,
    total: all.reduce((sum, session) => sum + session.total, 0),
    commands: [...byCommand.values()].sort(
      (a, b) => b.total - a.total || a.command.localeCompare(b.command),
    ),
  };
};
