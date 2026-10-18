import { version } from "../package.json";
import { binrec, type Binrec } from "./binrec.ts";

const usage = (b: Binrec) => `Usage:
  binrec --help            Show this help (also: -h); binrec <command> --help
                           shows the help of one command
  binrec --version         Print the binrec version
  binrec init [--rc <file>]
                           Create ${b.path} and add it to PATH in ~/.bashrc
                           (or <file>), first so shims take over
  binrec install           Create ${b.path} and show how to add it to PATH
  binrec install <bin>     Install a shim for <bin> in ${b.path}
  binrec uninstall <bin>   Remove the shim for <bin> (records are kept)
  binrec uninstall --all   Remove every shim in ${b.path} (records are kept)
  binrec on                Turn recording on (also: binrec enable)
  binrec off               Turn recording off, shims still run (also: binrec disable)
  binrec on <bin>          Same as binrec install <bin> (also: binrec enable <bin>)
  binrec off <bin>         Same as binrec uninstall <bin>, --all too (also: binrec disable <bin>)
  binrec stats             Show how many bytes the recorded sessions consumed and
                           rank the commands that consumed the most
  binrec list [<bin>]      List the recorded sessions (of <bin> only, if given) with
                           their id, oldest first
  binrec play [--timestamps] [--no-wait | --speed <n>] <id>
                           Play the session <id> back, writing its output with the
                           recorded timing (<n> times faster); --no-wait writes it
                           at once and --timestamps shows when each line was written
  binrec play --ui [--port <n>] <id>
                           Serve a page that plays the session <id> in a terminal
                           in the browser, with a timeline to rewind and fast-forward
  binrec rec [--records <dir>] [--config <file>] <path> [...]
                           Run <path> passing stdio through and record it in ${b.records}`;

/** Help of each command, shown by `binrec <command> --help`. */
const commandHelp: Record<string, (b: Binrec) => string> = {
  init: (b) => `Usage: binrec init [--rc <file>]

Create ${b.path} and configure ~/.bashrc so new shells have it at the start
of PATH, before the real binaries, and the shims take over. The lines go in a
block between "# >>> binrec >>>" and "# <<< binrec <<<"; running binrec init
again updates that block instead of adding another one. BINREC_HOME is
exported too when it is not the default ~/.binrec.

  --rc <file>   Startup file to configure instead of ~/.bashrc (e.g. ~/.zshrc)`,
  install: (b) => `Usage: binrec install [<bin>]

Without <bin>, create ${b.path} and show the line that adds it to PATH.
With <bin>, resolve the real path of <bin> and install a shim for it in
${b.path} that runs it through binrec rec, so every call is recorded in
${b.records}.`,
  uninstall: (b) => `Usage: binrec uninstall <bin>
       binrec uninstall --all

Remove the shim for <bin>, or every shim with --all, from ${b.path}.
Recorded sessions are kept.`,
  on: (b) => `Usage: binrec on [<bin>]

Without <bin>, turn recording on: shims save their sessions in ${b.records}.
With <bin>, same as binrec install <bin>. Also: binrec enable [<bin>]`,
  off: () => `Usage: binrec off [<bin> | --all]

Without <bin>, turn recording off: shims keep running the real binary but
nothing is recorded. With <bin> or --all, same as binrec uninstall.
Also: binrec disable [<bin> | --all]`,
  stats: (b) => `Usage: binrec stats

Show how many sessions are recorded in ${b.records}, how many bytes they
consumed in total, and rank the commands that consumed the most.`,
  rec: (b) => `Usage: binrec rec [--records <dir>] [--config <file>] <path> [...]

Run <path> with the given arguments, pass stdin, stdout and stderr through,
record the session and exit with the program's exit code. Only a lone
binrec rec --help shows this help; any other --help goes to the program.

  --records <dir>   Folder for the records (default: ${b.records})
  --config <file>   Settings file to read (default: ${b.config})`,
  list: (b) => `Usage: binrec list [<bin>]

List the sessions recorded in ${b.records}, oldest first, with their id,
start time, exit code, size and command line. With <bin> (a name like date
or an absolute path), list only the sessions of that binary.
Pass an id to binrec play to play a session back.`,
  play: (b) => `Usage: binrec play [--timestamps] [--no-wait | --speed <n>] <id>
       binrec play --ui [--port <n>] [--speed <n>] <id>

Play the session <id> from ${b.records} back: write its stdout and
stderr again, each chunk as long after the start as it was recorded.
The start of an id is enough when it matches only one session.

  --timestamps, -t  Show every line with its recorded timestamp, the time since
                    the session started and its stream (stdout or stderr), the
                    command line first and the exit code last
  --no-wait, -n     Write the whole output at once, without the recorded
                    waits, to see how the session ended (same as --speed 0)
  --speed <n>       Play <n> times faster (default: 1): 2 is twice as fast,
                    0.5 half as fast and 0 writes everything at once
  --ui              Instead of writing the output here, serve a page on
                    127.0.0.1 and print its address: it plays the session in a
                    terminal in the browser, with a timeline that marks every
                    change on the screen, to pause, rewind and fast-forward.
                    Runs until Ctrl+C
  --port <n>        Port for --ui (default: a free one)`,
};

const aliases: Record<string, string> = { enable: "on", disable: "off" };

const isHelpFlag = (arg?: string) => arg === "--help" || arg === "-h";

/**
 * True when `binrec <command> <...rest>` asks for the command's help. `rec`
 * passes its arguments on to the program, so only a lone `--help` counts there.
 */
const wantsHelp = (command: string, rest: string[]) =>
  isHelpFlag(rest[0]) && (command !== "rec" || rest.length === 1);

const init = async (b: Binrec, args: string[]) => {
  let rc: string | undefined;
  while (args[0] === "--rc") {
    rc = args[1];
    args = args.slice(2);
    if (!rc) {
      console.error("binrec: --rc needs a file");
      return 1;
    }
  }
  if (args[0] !== undefined) {
    console.error(usage(b));
    return 1;
  }

  const result = await b.initShell({ rc });
  console.log(result.changed ? `Configured ${result.rc}:` : `${result.rc} is already configured:`);
  console.log("");
  for (const line of result.lines) console.log(`  ${line}`);
  console.log("");
  console.log(`Open a new shell or run: source ${showArg(result.rc)}`);
  return 0;
};

const install = async (b: Binrec, command?: string) => {
  if (!command) {
    await b.init();
    console.log(`binrec bin directory ready: ${b.path}`);
    console.log("");
    console.log("Add it to the start of your PATH by appending this line to ~/.bashrc");
    console.log("(binrec init does it for you):");
    console.log("");
    console.log(`  export PATH="${b.path}:$PATH"`);
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

/** Shows an argument like a shell would need it, quoting it only when it has to. */
const showArg = (arg: string) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`);

const printList = async (b: Binrec, command?: string) => {
  const found = await b.sessions(command);
  if (found.length === 0) {
    console.log(`No recorded sessions${command ? ` of ${command}` : ""} in ${b.records}`);
    return 0;
  }

  const rows = found.map((session) => [
    session.sessionId,
    session.timestamp.replace(/\.\d+Z$/, "Z"),
    session.exitCode === null ? "-" : String(session.exitCode),
    formatBytes(session.total),
    [session.command, ...session.args].map(showArg).join(" "),
  ]);
  const header = ["ID", "STARTED", "EXIT", "SIZE", "COMMAND"];
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column]!.length)),
  );
  for (const row of [header, ...rows]) {
    const cells = row.map((cell, column) =>
      column === row.length - 1
        ? cell
        : column === 2 || column === 3
          ? cell.padStart(widths[column]!)
          : cell.padEnd(widths[column]!),
    );
    console.log(cells.join("  "));
  }
  return 0;
};

const playSession = async (b: Binrec, args: string[]) => {
  let speed = 1;
  let timestamps = false;
  let ui = false;
  let port: number | undefined;
  const flags = ["--speed", "--timestamps", "-t", "--no-wait", "-n", "--ui", "--port"];
  while (args[0] !== undefined && flags.includes(args[0])) {
    const flag = args[0];
    if (flag === "--timestamps" || flag === "-t" || flag === "--no-wait" || flag === "-n" || flag === "--ui") {
      if (flag === "--ui") ui = true;
      else if (flag === "--no-wait" || flag === "-n") speed = 0;
      else timestamps = true;
      args = args.slice(1);
      continue;
    }
    const value = Number(args[1]);
    args = args.slice(2);
    if (flag === "--port") {
      if (!Number.isInteger(value) || value < 0 || value > 65535) {
        console.error("binrec: --port must be a port number, 0 to 65535");
        return 1;
      }
      port = value;
      continue;
    }
    speed = value;
    if (!Number.isFinite(speed) || speed < 0) {
      console.error("binrec: --speed must be a number, 0 or more");
      return 1;
    }
  }
  const id = args[0];
  if (!id) {
    console.error(usage(b));
    return 1;
  }

  try {
    if (!ui) {
      await b.play(id, { speed, timestamps });
      return 0;
    }
    const server = await b.playUi(id, { port, speed: speed || 1 });
    console.log(`Playing ${id} at ${server.url}`);
    console.log("Open it in your browser. Press Ctrl+C to stop.");
    await new Promise<void>((resolve) => {
      for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => resolve());
    });
    await server.stop();
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 1;
  }
};

/** Runs the binrec CLI with `argv` (without the runtime and script) and exits the process. */
export const runCli = async (argv: string[]) => {
  const b = binrec.create();
  const [command, ...rest] = argv;

  // `binrec <command> --help` shows that command's help instead of running it.
  const helpOf = command && commandHelp[aliases[command] ?? command];
  if (helpOf && wantsHelp(command, rest)) {
    console.log(helpOf(b));
    process.exit(0);
  }

  switch (command) {
    case "--help":
    case "-h":
      console.log(usage(b));
      process.exit(0);
    case "--version":
    case "-v":
      console.log(version);
      process.exit(0);
    case "init":
      process.exit(await init(b, rest));
    case "install":
      process.exit(await install(b, rest[0]));
    case "uninstall":
      process.exit(await uninstall(b, rest[0]));
    case "on":
    case "enable":
      if (rest[0]) process.exit(await install(b, rest[0]));
      await b.enableRecords();
      console.log(`Recording is on: sessions are saved in ${b.records}`);
      process.exit(0);
    case "off":
    case "disable":
      if (rest[0]) process.exit(await uninstall(b, rest[0]));
      await b.disableRecords();
      console.log("Recording is off: shims run the real binary without recording");
      process.exit(0);
    case "stats":
      process.exit(await printStats(b));
    case "list":
      process.exit(await printList(b, rest[0]));
    case "play":
      process.exit(await playSession(b, rest));
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
