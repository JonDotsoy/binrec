import { mkdir, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";

export type CreateOptions = {
  /** Folder where shims are installed. Defaults to `$BINREC_HOME/bin` or `~/.binrec/bin`. */
  path?: string;
};

export type Binrec = {
  /** Absolute path of the folder that holds the shims; add it to PATH. */
  readonly path: string;
  /** Creates the bin folder if it does not exist yet. */
  init(): Promise<void>;
  /** Installs a shim for `command` and returns the shim's path. */
  install(command: string): Promise<string>;
};

const cliEntry = resolve(new URL("../bin/binrec.ts", import.meta.url).pathname);

export const defaultPath = () =>
  join(process.env.BINREC_HOME ?? join(homedir(), ".binrec"), "bin");

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

  const init = async () => {
    await mkdir(path, { recursive: true });
  };

  const install = async (command: string) => {
    const target = isAbsolute(command) ? command : whichOutside(command, path);
    if (!target) throw new Error(`binrec: command not found: ${command}`);

    await init();

    const shimPath = join(path, basename(command));
    const shim = [
      "#!/usr/bin/env bash",
      `exec ${shellQuote(process.execPath)} ${shellQuote(cliEntry)} rec ${shellQuote(target)} "$@"`,
      "",
    ].join("\n");

    await Bun.write(shimPath, shim);
    await chmod(shimPath, 0o755);
    return shimPath;
  };

  return { path, init, install };
};

/** Runs `target` with `args`, passing stdin, stdout and stderr through, and resolves to its exit code. */
export const rec = async (target: string, args: string[] = []) => {
  const child = Bun.spawn([target, ...args], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await child.exited;
};

export const binrec = { create, rec };
