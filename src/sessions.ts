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
  | { type: "end"; timestamp: string; performance: number; exitCode: number };

export type Session = {
  sessionId: string;
  /** Absolute path of the recorded binary. */
  command: string;
  args: string[];
  /** When the session started (ISO 8601). */
  timestamp: string;
  /** Exit code from the `end` line, or `null` if the session has not ended. */
  exitCode: number | null;
  /** Absolute path of the ndjson record. */
  recordPath: string;
  /** Every line of the record, in order. */
  lines: RecordLine[];
};

const readSession = async (recordPath: string): Promise<Session | null> => {
  const lines = (await Bun.file(recordPath).text())
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RecordLine);

  const first = lines[0];
  if (first?.type !== "command") return null;

  const end = lines.findLast((line) => line.type === "end");

  return {
    sessionId: first.sessionId,
    command: first.command,
    args: first.args,
    timestamp: first.timestamp,
    exitCode: end?.type === "end" ? end.exitCode : null,
    recordPath,
    lines,
  };
};

/** True when `command` (a name like `date` or an absolute path) is the recorded binary. */
const matches = (session: Session, command: string) =>
  isAbsolute(command)
    ? session.command === resolve(command)
    : basename(session.command) === command;

/** Lists every recorded session of `command` in `records`, oldest first. */
export const sessions = async (records: string, command: string): Promise<Session[]> => {
  let files: string[];
  try {
    files = (await readdir(records)).filter((file) => file.endsWith(".ndjson"));
  } catch {
    return [];
  }

  const found = await Promise.all(
    files.map(async (file) => {
      const recordPath = join(records, file);
      const session = await readSession(recordPath);
      if (!session || !matches(session, command)) return null;
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
