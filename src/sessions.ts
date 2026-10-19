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
      /**
       * Id of the session this one ran inside, like a command run from a recorded
       * shell, or `null`. Missing in older records.
       */
      parent?: string | null;
      /** How many binrec sessions this one ran inside, `0` when run on its own. Missing in older records. */
      depth?: number;
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

export type Session = {
  sessionId: string;
  /** Absolute path of the recorded binary. */
  command: string;
  args: string[];
  /** Id of the session this one ran inside, or `null` when it was not run from a recorded session. */
  parent: string | null;
  /** How many binrec sessions this one ran inside: `0` when run on its own (and in older records). */
  depth: number;
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

/** Reads one ndjson record, or returns `null` when it does not start with a `command` line. */
export const readSession = async (recordPath: string): Promise<Session | null> => {
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
    parent: first.parent ?? null,
    depth: typeof first.depth === "number" ? first.depth : 0,
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

/**
 * Finds the recorded session whose id is `id` or starts with `id` (like a short
 * git hash). Returns `null` when none matches and throws when more than one does.
 */
export const findSession = async (records: string, id: string): Promise<Session | null> => {
  if (!id || id.includes("/") || id.includes("\\")) return null;

  const exact = await readSession(join(records, `${id}.ndjson`)).catch(() => null); // missing record
  if (exact) return exact;

  let files: string[];
  try {
    files = (await readdir(records)).filter(
      (file) => file.endsWith(".ndjson") && file.startsWith(id),
    );
  } catch {
    return null;
  }
  if (files.length > 1) {
    const ids = files.map((file) => file.replace(/\.ndjson$/, "")).sort();
    throw new Error(`binrec: session id ${id} is ambiguous: ${ids.join(", ")}`);
  }
  if (files.length === 0) return null;
  return readSession(join(records, files[0]!)).catch(() => null); // unreadable record
};

/** A session with how deep it is nested in the tree: `0` for the root, `1` for its children. */
export type TreeSession = { session: Session; depth: number };

/** Every session of `found` followed by the sessions that ran inside it, starting from `roots`. */
const walk = (found: Session[], roots: Session[]): TreeSession[] => {
  const children = new Map<string, Session[]>();
  for (const session of found) {
    if (session.parent === null) continue;
    children.set(session.parent, [...(children.get(session.parent) ?? []), session]);
  }
  const ordered: TreeSession[] = [];
  const visited = new Set<string>();
  const visit = (session: Session, depth: number) => {
    if (visited.has(session.sessionId)) return; // a record that names itself, or a loop
    visited.add(session.sessionId);
    ordered.push({ session, depth });
    for (const child of children.get(session.sessionId) ?? []) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  return ordered;
};

/**
 * Orders `found` (oldest first) as trees: every session is followed by the
 * sessions that ran inside it. A session whose parent is not in `found` is a root.
 */
export const asTrees = (found: Session[]): TreeSession[] => {
  const ids = new Set(found.map((session) => session.sessionId));
  return walk(found, found.filter((session) => session.parent === null || !ids.has(session.parent)));
};

/**
 * The session whose id is `id` (or starts with it) followed by every session
 * that ran inside it, at any depth, oldest first under each parent. Returns an
 * empty list when there is no such session and throws when the id is ambiguous.
 * With `fromRoot`, the tree starts at the outermost recorded session `id` ran
 * inside instead (the one at depth 0 when it was recorded).
 */
export const sessionTree = async (
  records: string,
  id: string,
  { fromRoot = false }: { fromRoot?: boolean } = {},
): Promise<TreeSession[]> => {
  let root = await findSession(records, id);
  if (!root) return [];
  const all = await sessions(records);
  if (fromRoot) {
    const byId = new Map(all.map((session) => [session.sessionId, session]));
    const seen = new Set([root.sessionId]);
    for (let up = byId.get(root.parent ?? ""); up && !seen.has(up.sessionId); up = byId.get(up.parent ?? "")) {
      seen.add(up.sessionId);
      root = up;
    }
  }
  return walk(all, [root]);
};
