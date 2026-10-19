import { mkdir, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { DISABLED_MARKER, readConfig, type Config, rec } from "./rec.ts";
import { play, playTree, type PlayOptions } from "./play.ts";
import { playUi, type PlayUiOptions, type PlayUiServer } from "./ui/server.ts";
import { findSession, lastSession, sessionTree, sessions, type Session, type TreeSession } from "./sessions.ts";
import { stats, type Stats } from "./stats.ts";
import { shellLines } from "./shell.ts";
import { isShim, writeShim } from "./shim.ts";

export { rec } from "./rec.ts";
export { play, playTree } from "./play.ts";
export type { PlayOptions } from "./play.ts";
export { playUi } from "./ui/server.ts";
export type { PlayUiOptions, PlayUiServer, PlayUiSource } from "./ui/server.ts";
export type { Config, RecOptions, RecResult } from "./rec.ts";
export { asTrees, sessionTree } from "./sessions.ts";
export type { RecordLine, Session, TreeSession } from "./sessions.ts";
export type { CommandStats, Stats } from "./stats.ts";

export type CreateOptions = {
  /** Folder where shims are installed. Defaults to `$BINREC_HOME/bin` or `~/.binrec/bin`. */
  path?: string;
  /** Folder where `binrec rec` writes its ndjson records. Defaults to `records` next to `path`. */
  records?: string;
};

export type Binrec = {
  /** Absolute path of the folder that holds the shims; add it to PATH. */
  readonly path: string;
  /** Absolute path of the folder that holds the ndjson records. */
  readonly records: string;
  /** Absolute path of `config.json`, next to the bin folder (`~/.binrec/config.json`). */
  readonly config: string;
  /** Creates the bin folder if it does not exist yet. */
  init(): Promise<void>;
  /**
   * The `export` lines to add to `~/.bashrc` so the bin folder comes first in PATH
   * (and `BINREC_HOME` is set when it is not the default). Nothing is written.
   */
  shellLines(): string[];
  /** Installs a shim for `command` and returns the shim's path. */
  install(command: string): Promise<string>;
  /**
   * Removes the shim for `command` and returns its path, or `null` if no binrec
   * shim was installed for it. Recorded sessions are kept.
   */
  uninstall(command: string): Promise<string | null>;
  /** Removes every binrec shim in the bin folder and returns their paths. Recorded sessions are kept. */
  uninstallAll(): Promise<string[]>;
  /** Turns recording off for every shim using this records folder. */
  disableRecords(): Promise<void>;
  /** Turns recording back on. */
  enableRecords(): Promise<void>;
  /** With a command, same as `install(command)`; without one, same as `enableRecords()`. */
  on(command?: string): Promise<string | void>;
  /** With a command, same as `uninstall(command)`; without one, same as `disableRecords()`. */
  off(command?: string): Promise<string | null | void>;
  /** True unless recording was turned off with `disableRecords()` (`"recording": false` in `config.json`). */
  isRecording(): Promise<boolean>;
  /**
   * Every recorded session of `command` (a name like `date` or an absolute path),
   * or of every command when it is left out, oldest first.
   */
  sessions(command?: string): Promise<Session[]>;
  /**
   * The session whose id is `id` or starts with `id`, or `null` if there is none.
   * Throws when the id matches more than one session.
   */
  session(id: string): Promise<Session | null>;
  /**
   * The session `id` followed by every session that ran inside it, at any depth,
   * like the commands run from a recorded shell. Empty when there is no such session.
   */
  sessionTree(id: string, options?: { fromRoot?: boolean }): Promise<TreeSession[]>;
  /**
   * Writes the `stdout` and `stderr` of the session `id` again with its recorded
   * timing. With `tree`, plays the sessions that ran inside it too, every line
   * labeled with its session (see `playTree`).
   */
  play(id: string, options?: PlayOptions & { tree?: boolean }): Promise<void>;
  /**
   * Serves a page on 127.0.0.1 that plays the recorded sessions in a terminal in
   * the browser, with a timeline to pause, rewind and fast-forward them, and a
   * panel that lists every recorded session to pick one. The page plays the
   * whole run a session belongs to, from its outermost session: it shows when
   * every session ran and which one ran inside which. With `id`, it opens on
   * that session (throws if there is none); without it, on the panel.
   */
  playUi(id?: string, options?: Omit<PlayUiOptions, "selected">): Promise<PlayUiServer>;
  /** The most recent recorded session of `command`, or `null` if there is none. */
  lastSession(command: string): Promise<Session | null>;
  /** Bytes consumed by every recorded session, overall and per command (most first). */
  stats(): Promise<Stats>;
};

export const defaultPath = () =>
  join(process.env.BINREC_HOME ?? join(homedir(), ".binrec"), "bin");

/** Looks up a command in PATH, skipping `binDir` so a shim never resolves to itself. */
const whichOutside = (command: string, binDir: string) => {
  const path = (process.env.PATH ?? "")
    .split(delimiter)
    .filter((dir) => dir && resolve(dir) !== binDir)
    .join(delimiter);
  return Bun.which(command, { PATH: path });
};

const create = (options: CreateOptions = {}): Binrec => {
  const path = resolve(options.path ?? defaultPath());
  const records = resolve(options.records ?? join(dirname(path), "records"));
  const config = join(dirname(path), "config.json");

  const init = async () => {
    await mkdir(path, { recursive: true });
  };

  const install = async (command: string) => {
    const target = isAbsolute(command) ? command : whichOutside(command, path);
    if (!target) throw new Error(`binrec: command not found: ${command}`);

    await init();

    const shimPath = join(path, basename(command));
    await writeShim(shimPath, { target, records, config });
    return shimPath;
  };

  const uninstall = async (command: string) => {
    const shimPath = join(path, basename(command));
    const shim = Bun.file(shimPath);
    const content = await shim.text().catch(() => null); // missing file or a folder
    if (content === null || !isShim(content)) return null;

    await rm(shimPath);
    return shimPath;
  };

  const uninstallAll = async () => {
    const names = await readdir(path).catch(() => [] as string[]);
    const removed: string[] = [];
    for (const name of names.sort()) {
      const shimPath = await uninstall(name);
      if (shimPath) removed.push(shimPath);
    }
    return removed;
  };

  const legacyMarker = join(records, DISABLED_MARKER);

  const writeConfig = async (changes: Config) => {
    await mkdir(dirname(config), { recursive: true });
    const current = await readConfig(config);
    await Bun.write(config, `${JSON.stringify({ ...current, ...changes }, null, 2)}\n`);
  };

  const disableRecords = async () => {
    await writeConfig({ recording: false });
  };

  const enableRecords = async () => {
    await writeConfig({ recording: true });
    await rm(legacyMarker, { force: true });
  };

  const isRecording = async () =>
    (await readConfig(config)).recording !== false && !(await Bun.file(legacyMarker).exists());

  return {
    path,
    records,
    config,
    init,
    shellLines: () => shellLines(path),
    install,
    uninstall,
    uninstallAll,
    disableRecords,
    enableRecords,
    on: (command) => (command ? install(command) : enableRecords()),
    off: (command) => (command ? uninstall(command) : disableRecords()),
    isRecording,
    sessions: (command) => sessions(records, command),
    session: (id) => findSession(records, id),
    sessionTree: (id, options) => sessionTree(records, id, options),
    play: async (id, { tree, ...options } = {}) => {
      const sessions = tree ? await sessionTree(records, id) : [];
      const session = tree ? sessions[0]?.session : await findSession(records, id);
      if (!session) throw new Error(`binrec: no recorded session ${id} in ${records}`);
      await (tree ? playTree(sessions, options) : play(session, options));
    },
    playUi: async (id, options = {}) => {
      const session = id === undefined ? null : await findSession(records, id);
      if (id !== undefined && !session) throw new Error(`binrec: no recorded session ${id} in ${records}`);
      const source = {
        sessions: () => sessions(records),
        tree: (id: string) => sessionTree(records, id, { fromRoot: true }),
      };
      return playUi(source, { ...options, selected: session?.sessionId });
    },
    lastSession: (command) => lastSession(records, command),
    stats: () => stats(records),
  };
};

export const binrec = { create, rec };
