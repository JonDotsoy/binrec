import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RECORD_FILE_MODE } from "./rec.ts";
import { sessions } from "./sessions.ts";

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

/** File in the records folder that holds the running totals, rewritten after every session. */
export const STATS_FILE = "stats.json";

const sortCommands = (commands: CommandStats[]) =>
  commands.sort((a, b) => b.total - a.total || a.command.localeCompare(b.command));

/** Adds up the bytes of every record in `records`, overall and per command. */
const computeStats = async (records: string): Promise<Stats> => {
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
    commands: sortCommands([...byCommand.values()]),
  };
};

const readStatsFile = async (path: string): Promise<Stats | null> => {
  try {
    const stats = await Bun.file(path).json();
    return Array.isArray(stats?.commands) ? stats : null;
  } catch {
    return null;
  }
};

/** Replaces the stats file in one step, so a reader never sees half of it. */
const writeStatsFile = async (path: string, stats: Stats) => {
  const temp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(stats, null, 2)}\n`, { mode: RECORD_FILE_MODE, flag: "wx" });
  await rename(temp, path);
};

/** A lock older than this belongs to a session that died while holding it. */
const STALE_LOCK_MS = 10_000;

/** Runs `update` while holding a lock on the stats file, so concurrent sessions don't lose counts. */
const withLock = async <T>(path: string, update: () => Promise<T>) => {
  const lock = `${path}.lock`;
  for (let attempt = 0; ; attempt++) {
    try {
      await mkdir(lock);
      break;
    } catch {
      const age = await stat(lock).then((s) => Date.now() - s.mtimeMs, () => 0);
      if (age > STALE_LOCK_MS || attempt >= 500) {
        await rm(lock, { recursive: true, force: true });
      } else {
        await Bun.sleep(10);
      }
    }
  }
  try {
    return await update();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
};

/**
 * Adds a finished session to `<records>/stats.json`. When the file does not
 * exist yet it is built from every record in the folder, the new one included.
 */
export const addToStats = async (records: string, command: string, total: number) => {
  const path = join(records, STATS_FILE);
  await withLock(path, async () => {
    const current = await readStatsFile(path);
    if (!current) {
      await writeStatsFile(path, await computeStats(records));
      return;
    }

    const entry = current.commands.find((item) => item.command === command);
    if (entry) {
      entry.sessions += 1;
      entry.total += total;
    } else {
      current.commands.push({ command, sessions: 1, total });
    }
    await writeStatsFile(path, {
      sessions: current.sessions + 1,
      total: current.total + total,
      commands: sortCommands(current.commands),
    });
  });
};

/**
 * Bytes consumed by the recorded sessions, overall and per command. Reads
 * `<records>/stats.json`; when it is missing, builds it from the records first.
 */
export const stats = async (records: string): Promise<Stats> => {
  const path = join(records, STATS_FILE);
  const current = await readStatsFile(path);
  if (current) return current;

  const computed = await computeStats(records);
  if (computed.sessions > 0) {
    await withLock(path, async () => {
      if (!(await readStatsFile(path))) await writeStatsFile(path, computed);
    }).catch(() => {}); // read-only records folder: the numbers are still right
  }
  return computed;
};
