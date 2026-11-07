import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RECORD_FILE_MODE } from "./rec.ts";
import { readSession } from "./sessions.ts";

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

/** What `<sessionId>.stats.json` holds: the size of one finished session. */
export type SessionStats = {
  sessionId: string;
  /** Absolute path of the recorded binary. */
  command: string;
  /** Bytes read and written in the session. */
  total: number;
};

/** Path of the stats file written next to the record `<sessionId>.ndjson`. */
export const statsPath = (recordPath: string) => recordPath.replace(/\.ndjson$/, ".stats.json");

/** Writes the stats file of a finished session; each session writes only its own. */
export const writeSessionStats = async (recordPath: string, stats: SessionStats) => {
  await writeFile(statsPath(recordPath), `${JSON.stringify(stats)}\n`, { mode: RECORD_FILE_MODE });
};

const readSessionStats = async (recordPath: string): Promise<SessionStats | null> => {
  try {
    const stats = await Bun.file(statsPath(recordPath)).json();
    return typeof stats?.total === "number" && typeof stats?.command === "string" ? stats : null;
  } catch {
    return null;
  }
};

/**
 * Stats of the record at `recordPath`: its stats file, or, when there is none
 * (older or unfinished records), the record itself. A finished record without a
 * stats file gets one, so the next run reads only the small file.
 */
const statsOf = async (recordPath: string): Promise<SessionStats | null> => {
  const cached = await readSessionStats(recordPath);
  if (cached) return cached;

  const session = await readSession(recordPath).catch(() => null); // unreadable record
  if (!session) return null;
  const stats = { sessionId: session.sessionId, command: session.command, total: session.total };
  if (session.exitCode !== null) {
    await writeSessionStats(recordPath, stats).catch(() => {}); // read-only records folder
  }
  return stats;
};

/**
 * Bytes consumed by the sessions recorded in `records`, overall and per
 * command. Only records that still exist are counted, so deleting a record
 * takes it out of the stats.
 */
export const stats = async (records: string): Promise<Stats> => {
  let files: string[];
  try {
    files = (await readdir(records)).filter((file) => file.endsWith(".ndjson"));
  } catch {
    files = [];
  }

  const all = (await Promise.all(files.map((file) => statsOf(join(records, file))))).filter(
    (item) => item !== null,
  );

  const byCommand = new Map<string, CommandStats>();
  for (const { command, total } of all) {
    const entry = byCommand.get(command) ?? { command, sessions: 0, total: 0 };
    entry.sessions += 1;
    entry.total += total;
    byCommand.set(command, entry);
  }

  return {
    sessions: all.length,
    total: all.reduce((sum, { total }) => sum + total, 0),
    commands: [...byCommand.values()].sort(
      (a, b) => b.total - a.total || a.command.localeCompare(b.command),
    ),
  };
};
