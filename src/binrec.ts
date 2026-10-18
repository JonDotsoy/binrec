import { mkdir, chmod, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { DISABLED_MARKER, readConfig, type Config, rec } from "./rec.ts";
import { lastSession, sessions, stats, type Session, type Stats } from "./sessions.ts";

export { rec } from "./rec.ts";
export type { Config, RecOptions, RecResult } from "./rec.ts";
export type { CommandStats, RecordLine, Session, Stats } from "./sessions.ts";

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
  /** Every recorded session of `command` (a name like `date` or an absolute path), oldest first. */
  sessions(command: string): Promise<Session[]>;
  /** The most recent recorded session of `command`, or `null` if there is none. */
  lastSession(command: string): Promise<Session | null>;
  /** Bytes consumed by every recorded session, overall and per command (most first). */
  stats(): Promise<Stats>;
};

// Set by scripts/build.ts: in dist/binrec.js the bundle itself is the CLI.
declare const BINREC_BUNDLED: boolean | undefined;

/** Script the shims run as `bun <cliEntry> rec …`. */
const cliEntry =
  typeof BINREC_BUNDLED !== "undefined" && BINREC_BUNDLED
    ? import.meta.path
    : resolve(import.meta.dir, "../bin/binrec.ts");

export const defaultPath = () =>
  join(process.env.BINREC_HOME ?? join(homedir(), ".binrec"), "bin");

/** Every shim starts with these lines, so `uninstall` never removes a file binrec did not write. */
const SHIM_HEADER = "#!/usr/bin/env bash\nexec ";
const isShim = (content: string) => content.startsWith(SHIM_HEADER) && content.includes(" rec --records ");

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

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
    const shim = [
      `${SHIM_HEADER}${shellQuote(process.execPath)} ${shellQuote(cliEntry)} rec --records ${shellQuote(records)} --config ${shellQuote(config)} ${shellQuote(target)} "$@"`,
      "",
    ].join("\n");

    await Bun.write(shimPath, shim);
    await chmod(shimPath, 0o755);
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
    install,
    uninstall,
    uninstallAll,
    disableRecords,
    enableRecords,
    on: (command) => (command ? install(command) : enableRecords()),
    off: (command) => (command ? uninstall(command) : disableRecords()),
    isRecording,
    sessions: (command) => sessions(records, command),
    lastSession: (command) => lastSession(records, command),
    stats: () => stats(records),
  };
};

export const binrec = { create, rec };
