import { version } from "../package.json";
import { binrec, type Binrec } from "./binrec.ts";

const usage = (b: Binrec) => `Usage:
  binrec --version         Print the binrec version
  binrec install           Create ${b.path} and show how to add it to PATH
  binrec install <bin>     Install a shim for <bin> in ${b.path}
  binrec uninstall <bin>   Remove the shim for <bin> (records are kept)
  binrec uninstall --all   Remove every shim in ${b.path} (records are kept)
  binrec on                Turn recording on (also: binrec enable)
  binrec off               Turn recording off, shims still run (also: binrec disable)
  binrec on <bin>          Same as binrec install <bin>
  binrec off <bin>         Same as binrec uninstall <bin>
  binrec stats             Show how many bytes the recorded sessions consumed and
                           rank the commands that consumed the most
  binrec rec [--records <dir>] [--config <file>] <path> [...]
                           Run <path> passing stdio through and record it in ${b.records}`;

const install = async (b: Binrec, command?: string) => {
  if (!command) {
    await b.init();
    console.log(`binrec bin directory ready: ${b.path}`);
    console.log("");
    console.log("Add it to your PATH by appending this line to ~/.bashrc:");
    console.log("");
    console.log(`  export PATH="$PATH:${b.path}"`);
    console.log("");
    console.log("Then reload your shell with: source ~/.bashrc");
    return 0;
  }

  try {
    const shimPath = await b.install(command);
    console.log(`Installed ${shimPath}`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 1;
  }
};

const uninstall = async (b: Binrec, command?: string) => {
  if (!command) {
    console.error(usage(b));
    return 1;
  }

  if (command === "--all") {
    const removed = await b.uninstallAll();
    for (const shimPath of removed) console.log(`Uninstalled ${shimPath}`);
    if (removed.length === 0) console.log(`No shims installed in ${b.path}`);
    return 0;
  }

  const shimPath = await b.uninstall(command);
  if (!shimPath) {
    console.error(`binrec: no shim installed for ${command} in ${b.path}`);
    return 1;
  }
  console.log(`Uninstalled ${shimPath}`);
  return 0;
};

/** Formats a byte count for people, like `1.5 KB`. */
const formatBytes = (bytes: number) => {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${bytes} B` : `${value.toFixed(1)} ${units[unit]}`;
};

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

const printStats = async (b: Binrec) => {
  const { sessions, total, commands } = await b.stats();
  if (sessions === 0) {
    console.log(`No recorded sessions in ${b.records}`);
    return 0;
  }

  console.log(`Sessions: ${sessions}`);
  console.log(`Consumed: ${formatBytes(total)} (${plural(total, "byte")})`);
  console.log("");
  console.log("Commands that consumed the most:");
  const width = Math.max(...commands.map(({ command }) => command.length));
  const sizes = commands.map(({ total }) => formatBytes(total));
  const sizeWidth = Math.max(...sizes.map((size) => size.length));
  const rankWidth = String(commands.length).length;
  commands.forEach(({ command, sessions }, index) => {
    const rank = `${index + 1}.`.padStart(rankWidth + 1);
    console.log(
      `  ${rank} ${command.padEnd(width)}  ${sizes[index]!.padStart(sizeWidth)}  ${plural(sessions, "session")}`,
    );
  });
  return 0;
};

/** Runs the binrec CLI with `argv` (without the runtime and script) and exits the process. */
export const runCli = async (argv: string[]) => {
  const b = binrec.create();
  const [command, ...rest] = argv;

  switch (command) {
    case "--version":
    case "-v":
      console.log(version);
      process.exit(0);
    case "install":
      process.exit(await install(b, rest[0]));
    case "uninstall":
      process.exit(await uninstall(b, rest[0]));
    case "on":
    case "enable":
      if (command === "on" && rest[0]) process.exit(await install(b, rest[0]));
      await b.enableRecords();
      console.log(`Recording is on: sessions are saved in ${b.records}`);
      process.exit(0);
    case "off":
    case "disable":
      if (command === "off" && rest[0]) process.exit(await uninstall(b, rest[0]));
      await b.disableRecords();
      console.log("Recording is off: shims run the real binary without recording");
      process.exit(0);
    case "stats":
      process.exit(await printStats(b));
    case "rec": {
      let records = b.records;
      let config: string | undefined = b.config;
      while (rest[0] === "--records" || rest[0] === "--config") {
        const [flag, value] = rest.splice(0, 2);
        if (flag === "--records") records = value ?? records;
        else config = value;
      }
      if (!rest[0]) {
        console.error(usage(b));
        process.exit(1);
      }
      const { exitCode } = await binrec.rec(rest[0], rest.slice(1), { records, config });
      process.exit(exitCode);
    }
    default:
      console.error(usage(b));
      process.exit(command ? 1 : 0);
  }
};
