import { chmod, readdir, stat, symlink } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";

// Set by scripts/build.ts: in dist/binrec.js the bundle itself is the CLI.
declare const BINREC_BUNDLED: boolean | undefined;

/** Script the shims run as `bun <cliEntry> rec …`. */
const cliEntry =
  typeof BINREC_BUNDLED !== "undefined" && BINREC_BUNDLED
    ? import.meta.path
    : resolve(import.meta.dir, "../bin/binrec.ts");

/**
 * Every shim starts with these lines, so `uninstall` never removes a file binrec did not write.
 * The shell is an absolute path: `#!/usr/bin/env bash` looks bash up in PATH, so a
 * shim for `bash` would run itself forever.
 */
const SHIM_HEADER = "#!/bin/sh\nexec ";
/** Header of shims written by binrec 0.0.5 and older. */
const LEGACY_SHIM_HEADER = "#!/usr/bin/env bash\nexec ";

/** True when `content` is a shim binrec wrote. */
export const isShim = (content: string) =>
  (content.startsWith(SHIM_HEADER) || content.startsWith(LEGACY_SHIM_HEADER)) &&
  content.includes(" rec --records ");

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * Writes an executable shim at `shimPath` that runs `binrec rec` on `target`,
 * with `--config` only when `config` is given.
 */
export const writeShim = async (
  shimPath: string,
  { target, records, config }: { target: string; records: string; config?: string },
) => {
  const configFlag = config === undefined ? "" : ` --config ${shellQuote(config)}`;
  const shim = [
    `${SHIM_HEADER}${shellQuote(process.execPath)} ${shellQuote(cliEntry)} rec --records ${shellQuote(records)}${configFlag} ${shellQuote(target)} "$@"`,
    "",
  ].join("\n");
  await Bun.write(shimPath, shim);
  await chmod(shimPath, 0o755);
};

/** File in a `--shim-all` folder that every command name links to. */
export const DISPATCHER = ".binrec-dispatch";

/**
 * Commands `--shim-all` leaves alone unless named with `--shim`: binrec's own
 * runtime, commands that change the terminal (they would change binrec's pseudo
 * terminal instead of the real one), commands that read passwords or keys, and
 * commands whose job depends on being the direct child of the caller.
 */
export const SHIM_ALL_EXCLUDED = [
  "bun",
  "binrec",
  "sudo",
  "su",
  "doas",
  "ssh",
  "gpg",
  "pass",
  "stty",
  "tty",
  "tput",
  "reset",
  "nohup",
  "setsid",
  "timeout",
];

/**
 * Writes the script every `--shim-all` link runs. It takes the command name from
 * `$0` and looks it up in the `PATH` it gets at run time, skipping `shimDir` and
 * shims from `binrec install`, so a program that changes its `PATH` (a Python
 * venv, `nvm use`) still runs the command it would run without binrec. Every
 * test is a shell builtin: running `head` or `grep` here would hit a link again.
 */
export const writeDispatcher = async (
  shimDir: string,
  { records, config }: { records: string; config?: string },
) => {
  const configFlag = config === undefined ? "" : ` --config ${shellQuote(config)}`;
  const script = `#!/bin/sh
name=\${0##*/}
self=${shellQuote(shimDir)}
rest=$PATH
while [ -n "$rest" ]; do
  dir=\${rest%%:*}
  case $rest in *:*) rest=\${rest#*:} ;; *) rest= ;; esac
  [ -n "$dir" ] || dir=.
  [ "$dir" = "$self" ] && continue
  file=$dir/$name
  [ -f "$file" ] && [ -x "$file" ] || continue
  first= second=
  { IFS= read -r first; IFS= read -r second; } <"$file" 2>/dev/null
  case $first in '#!/bin/sh'|'#!/usr/bin/env bash')
    case $second in 'exec '*' rec --records '*) continue ;; esac ;;
  esac
  exec ${shellQuote(process.execPath)} ${shellQuote(cliEntry)} rec --records ${shellQuote(records)}${configFlag} "$file" "$@"
done
echo "$name: command not found" >&2
exit 127
`;
  const path = join(shimDir, DISPATCHER);
  await Bun.write(path, script);
  await chmod(path, 0o755);
  return path;
};

/**
 * Links every executable name found in `PATH` (except `skip` and names starting
 * with `.`) to the dispatcher in `shimDir`. Returns how many links it made.
 */
export const linkPathCommands = async (shimDir: string, skip: Set<string>) => {
  const seen = new Set<string>();
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir || resolve(dir) === shimDir) continue;
    const names = (await readdir(dir).catch(() => [] as string[])).filter(
      (name) => !seen.has(name) && !skip.has(name) && !name.startsWith("."),
    );
    const infos = await Promise.all(names.map((name) => stat(join(dir, name)).catch(() => null)));
    const found = names.filter((_, i) => infos[i]?.isFile() && (infos[i]!.mode & 0o111) !== 0);
    for (const name of found) seen.add(name);
    await Promise.all(found.map((name) => symlink(DISPATCHER, join(shimDir, name))));
  }
  return seen.size;
};
