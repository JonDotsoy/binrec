#!/usr/bin/env bun
import { mkdir, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";

const binrecHome = process.env.BINREC_HOME ?? join(homedir(), ".binrec");
const binDir = join(binrecHome, "bin");
const binrecEntry = resolve(import.meta.path);

const usage = `Usage:
  binrec install           Create ${binDir} and show how to add it to PATH
  binrec install <bin>     Install a shim for <bin> in ${binDir}
  binrec rec <path> [...]  Run <path> with the given arguments, passing stdio through`;

/** Looks up a command in PATH, skipping binrec's own bin dir so a shim never resolves to itself. */
const whichOutsideBinDir = (command: string) => {
  const path = (process.env.PATH ?? "")
    .split(delimiter)
    .filter((dir) => dir && resolve(dir) !== resolve(binDir))
    .join(delimiter);
  return Bun.which(command, { PATH: path });
};

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

const install = async (command?: string) => {
  await mkdir(binDir, { recursive: true });

  if (!command) {
    console.log(`binrec bin directory ready: ${binDir}`);
    console.log("");
    console.log("Add it to your PATH by appending this line to ~/.bashrc:");
    console.log("");
    console.log(`  export PATH="$PATH:${binDir}"`);
    console.log("");
    console.log("Then reload your shell with: source ~/.bashrc");
    return 0;
  }

  const target = isAbsolute(command) ? command : whichOutsideBinDir(command);
  if (!target) {
    console.error(`binrec: command not found: ${command}`);
    return 1;
  }

  const shimPath = join(binDir, basename(command));
  const shim = [
    "#!/usr/bin/env bash",
    `exec ${shellQuote(process.execPath)} ${shellQuote(binrecEntry)} rec ${shellQuote(target)} "$@"`,
    "",
  ].join("\n");

  await Bun.write(shimPath, shim);
  await chmod(shimPath, 0o755);

  console.log(`Installed ${shimPath} -> ${target}`);
  return 0;
};

const rec = async (target?: string, args: string[] = []) => {
  if (!target) {
    console.error(usage);
    return 1;
  }

  const child = Bun.spawn([target, ...args], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  return await child.exited;
};

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case "install":
    process.exit(await install(rest[0]));
  case "rec":
    process.exit(await rec(rest[0], rest.slice(1)));
  default:
    console.error(usage);
    process.exit(command ? 1 : 0);
}
