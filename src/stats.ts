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

/** What `stats.json` holds. */
type StatsFile = Stats & {
  /**
   * Sessions a rebuild already counted that may still be about to add
   * themselves; each one is dropped from the list instead of counted twice.
   */
  counted?: string[];
};

/** A session adds itself right after it ends; records newer than this may not have yet. */
const PENDING_MS = 60_000;

const sortCommands = (commands: CommandStats[]) =>
  commands.sort((a, b) => b.total - a.total || a.command.localeCompare(b.command));

const recordAge = (recordPath: string) =>
  stat(recordPath).then((s) => Date.now() - s.mtimeMs, () => Infinity);

/** True when the session of `recordPath` ended so recently that it may not have added itself yet. */
const mayBePending = async (recordPath: string) => (await recordAge(recordPath)) < PENDING_MS;

/**
 * Adds up the bytes of every finished record in `records`, overall and per
 * command. Records without an `end` line are left out: a running session adds
 * itself when it ends.
 */
const computeStats = async (records: string): Promise<StatsFile> => {
  const all = (await sessions(records)).filter((session) => session.exitCode !== null);
  const byCommand = new Map<string, CommandStats>();
  const counted: string[] = [];
  for (const session of all) {
    const entry = byCommand.get(session.command) ?? {
      command: session.command,
      sessions: 0,
      total: 0,
    };
    entry.sessions += 1;
    entry.total += session.total;
    byCommand.set(session.command, entry);
    if (await mayBePending(session.recordPath)) counted.push(session.sessionId);
  }

  return {
    sessions: all.length,
    total: all.reduce((sum, session) => sum + session.total, 0),
    commands: sortCommands([...byCommand.values()]),
    counted,
  };
};

const readStatsFile = async (path: string): Promise<StatsFile | null> => {
  try {
    const stats = await Bun.file(path).json();
    return Array.isArray(stats?.commands) ? stats : null;
  } catch {
    return null;
  }
};

/** Replaces the stats file in one step, so a reader never sees half of it. */
const writeStatsFile = async (path: string, stats: StatsFile) => {
  const temp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(stats, null, 2)}\n`, { mode: RECORD_FILE_MODE, flag: "wx" });
  await rename(temp, path);
};

/** A lock older than this belongs to a session that died while holding it; an update takes milliseconds. */
const STALE_LOCK_MS = 10_000;

/** Runs `update` while holding a lock on the stats file, so concurrent sessions don't lose counts. */
const withLock = async <T>(path: string, update: () => Promise<T>) => {
  const lock = `${path}.lock`;
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      // A missing records folder means there is nothing to lock.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const age = await stat(lock).then((s) => Date.now() - s.mtimeMs, () => 0);
      if (age > STALE_LOCK_MS) await rm(lock, { recursive: true, force: true });
      else await Bun.sleep(5 + Math.random() * 10);
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
export const addToStats = async (
  records: string,
  session: { sessionId: string; command: string; total: number },
) => {
  const path = join(records, STATS_FILE);
  await withLock(path, async () => {
    const current = (await readStatsFile(path)) ?? (await computeStats(records));
    // Ids whose session ended long ago will never come back; drop them.
    const counted: string[] = [];
    for (const id of current.counted ?? []) {
      if (await mayBePending(join(records, `${id}.ndjson`))) counted.push(id);
    }

    if (counted.includes(session.sessionId)) {
      // A rebuild already counted this session.
      const rest = counted.filter((id) => id !== session.sessionId);
      await writeStatsFile(path, { ...current, counted: rest.length ? rest : undefined });
      return;
    }

    const entry = current.commands.find((item) => item.command === session.command);
    if (entry) {
      entry.sessions += 1;
      entry.total += session.total;
    } else {
      current.commands.push({ command: session.command, sessions: 1, total: session.total });
    }
    await writeStatsFile(path, {
      sessions: current.sessions + 1,
      total: current.total + session.total,
      commands: sortCommands(current.commands),
      counted: counted.length ? counted : undefined,
    });
  });
};

/**
 * Bytes consumed by the recorded sessions, overall and per command. Reads
 * `<records>/stats.json`; when it is missing, builds it from the records first.
 */
export const stats = async (records: string): Promise<Stats> => {
  const path = join(records, STATS_FILE);
  const toStats = ({ sessions, total, commands }: StatsFile): Stats => ({
    sessions,
    total,
    commands,
  });
  const current = await readStatsFile(path);
  if (current) return toStats(current);

  try {
    return toStats(
      await withLock(path, async () => {
        const existing = await readStatsFile(path);
        if (existing) return existing;
        const computed = await computeStats(records);
        if (computed.sessions > 0) await writeStatsFile(path, computed);
        return computed;
      }),
    );
  } catch {
    return toStats(await computeStats(records)); // read-only records folder
  }
};
