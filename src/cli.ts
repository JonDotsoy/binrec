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
  binrec rec [--records <dir>] <path> [...]
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
      await b.enableRecords();
      console.log(`Recording is on: sessions are saved in ${b.records}`);
      process.exit(0);
    case "off":
    case "disable":
      await b.disableRecords();
      console.log("Recording is off: shims run the real binary without recording");
      process.exit(0);
    case "rec": {
      let records = b.records;
      if (rest[0] === "--records") {
        records = rest[1] ?? records;
        rest.splice(0, 2);
      }
      if (!rest[0]) {
        console.error(usage(b));
        process.exit(1);
      }
      const { exitCode } = await binrec.rec(rest[0], rest.slice(1), { records });
      process.exit(exitCode);
    }
    default:
      console.error(usage(b));
      process.exit(command ? 1 : 0);
  }
};
