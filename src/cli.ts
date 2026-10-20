import { version } from "../package.json";
import { asTrees, binrec, type Binrec } from "./binrec.ts";
import { formatOf, videoFormats, type VideoFormat } from "./video/export.ts";

const usage = (b: Binrec) => `Usage:
  binrec --help            Show this help (also: -h); binrec <command> --help
                           shows the help of one command
  binrec --version         Print the binrec version
  binrec init              Create ${b.path} and show the export lines to add
                           to ~/.bashrc so it comes first in PATH (also: binrec install)
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
                           their id, oldest first, each one followed by the sessions
                           that ran inside it
  binrec play [--timestamps] [--no-wait | --speed <n>] [--tree] <id>
                           Play the session <id> back, writing its output with the
                           recorded timing (<n> times faster); --no-wait writes it
                           at once, --timestamps shows when each line was written
                           and --tree plays the sessions that ran inside it too
  binrec play --ui [--port <n>] [<id>]
                           Serve a page that plays the recorded sessions in a
                           terminal in the browser: a panel to pick one, every
                           process of its run on a timeline, rewind and fast-forward
  binrec export [--output <file>] [--format mp4|webm|gif] [--speed <n>] [--fps <n>]
                [--max-pause <s>] [--force] <id>
                           Turn the session <id> into a video (needs ffmpeg)
  binrec rec [--records <dir>] [--config <file>] <path> [...]
                           Run <path> passing stdio through and record it in ${b.records}`;

/** Help of each command, shown by `binrec <command> --help`. */
const commandHelp: Record<string, (b: Binrec) => string> = {
  init: (b) => `Usage: binrec init

Create ${b.path} and show the export lines to add to ~/.bashrc (or the
startup file of your shell) so new shells have it at the start of PATH,
before the real binaries, and the shims take over. BINREC_HOME is exported
too when it is not the default ~/.binrec. No file is changed: add the lines
yourself. Also: binrec install`,
  install: (b) => `Usage: binrec install [<bin>]

Without <bin>, same as binrec init: create ${b.path} and show the lines
that add it to PATH.
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
start time, exit code, size and command line. A session run inside another
one (a command run from a recorded shell, or by a recorded tool) is listed
right after it, indented under it. With <bin> (a name like date or an
absolute path), list only the sessions of that binary.
Pass an id to binrec play to play a session back.`,
  play: (b) => `Usage: binrec play [--timestamps] [--no-wait | --speed <n>] [--tree] <id>
       binrec play --ui [--port <n>] [--speed <n>] [<id>]

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
  --tree, -T        Play the sessions that ran inside <id> too (like the
                    commands run from a recorded shell), interleaved by time:
                    every line starts with the session that wrote it, as
                    name[id], indented by how deep it is nested, and each
                    session shows its command line and exit code. Output a
                    session only passed on from one inside it is shown once,
                    under the inner session
  --ui              Instead of writing the output here, serve a page on
                    127.0.0.1 and print its address: it plays the session in a
                    terminal in the browser, with a timeline that marks every
                    change on the screen, to pause, rewind and fast-forward.
                    It shows every process of the run the session belongs to
                    (from the outermost one) as a bar from its start to its
                    end, nested under the one it ran inside; pick one to show
                    it in the terminal. A panel lists every recorded session
                    to open another one; without <id> the page opens on it.
                    Runs until Ctrl+C
  --port <n>        Port for --ui (default: a free one)`,
  export: (b) => `Usage: binrec export [--output <file>] [--format mp4|webm|gif] [--speed <n>]
                     [--fps <n>] [--max-pause <s>] [--force] <id>

Turn the session <id> from ${b.records} into a video: its output is played
into a terminal of the recorded size and every frame is drawn like the
terminal of binrec play --ui. ffmpeg must be installed (it encodes the video).
The start of an id is enough when it matches only one session.

  --output <file>, -o   Where to write the video (default: binrec-<id>.<format>
                        in the current folder)
  --format <format>     mp4 (H.264), webm (VP9) or gif (default: the extension
                        of --output, or mp4)
  --speed <n>           Play <n> times faster (default: 1)
  --fps <n>             Frames per second (default: 30, 15 for a GIF)
  --max-pause <s>       Cut every wait longer than <s> seconds to <s>, like a
                        shell waiting for you to type (default: 5); a negative
                        number keeps every wait as recorded
  --force, -f           Replace the file if it already exists`,
};

const aliases: Record<string, string> = { enable: "on", disable: "off" };

const isHelpFlag = (arg?: string) => arg === "--help" || arg === "-h";

/**
 * True when `binrec <command> <...rest>` asks for the command's help. `rec`
 * passes its arguments on to the program, so only a lone `--help` counts there.
 */
const wantsHelp = (command: string, rest: string[]) =>
  isHelpFlag(rest[0]) && (command !== "rec" || rest.length === 1);

const init = async (b: Binrec) => {
  await b.init();
  console.log(`binrec bin directory ready: ${b.path}`);
  console.log("");
  console.log("Add it to the start of your PATH by appending these lines to ~/.bashrc:");
  console.log("");
  for (const line of b.shellLines()) console.log(`  ${line}`);
  console.log("");
  console.log("Then reload your shell with: source ~/.bashrc");
  return 0;
};

const install = async (b: Binrec, command?: string) => {
  if (!command) return init(b);

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

  // Sessions run inside another one come right after it, indented under it.
  const rows = asTrees(found).map(({ session, depth }) => [
    session.sessionId,
    session.timestamp.replace(/\.\d+Z$/, "Z"),
    session.exitCode === null ? "-" : String(session.exitCode),
    formatBytes(session.total),
    (depth ? `${"   ".repeat(depth - 1)}└─ ` : "") + [session.command, ...session.args].map(showArg).join(" "),
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
  let tree = false;
  let port: number | undefined;
  const flags = ["--speed", "--timestamps", "-t", "--no-wait", "-n", "--ui", "--port", "--tree", "-T"];
  while (args[0] !== undefined && flags.includes(args[0])) {
    const flag = args[0];
    if (flag !== "--speed" && flag !== "--port") {
      if (flag === "--ui") ui = true;
      else if (flag === "--tree" || flag === "-T") tree = true;
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
  if (!id && !ui) {
    console.error(usage(b));
    return 1;
  }

  try {
    if (!ui) {
      await b.play(id!, { speed, timestamps, tree });
      return 0;
    }
    const server = await b.playUi(id, { port, speed: speed || 1 });
    console.log(id ? `Playing ${id} at ${server.url}` : `Serving the sessions in ${b.records} at ${server.url}`);
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

const exportSession = async (b: Binrec, args: string[]) => {
  let output: string | undefined;
  let format: VideoFormat | undefined;
  let speed: number | undefined;
  let fps: number | undefined;
  let maxPause: number | undefined;
  let overwrite = false;
  let id: string | undefined;
  const numberOf = (flag: string, value: string | undefined) => {
    const number = Number(value);
    if (value === undefined || value === "" || !Number.isFinite(number)) {
      throw new Error(`binrec: ${flag} must be a number`);
    }
    return number;
  };
  try {
    while (args.length) {
      const [arg, value] = args;
      args = args.slice(1);
      if (arg === "--force" || arg === "-f") {
        overwrite = true;
        continue;
      }
      if (!arg!.startsWith("-") || arg === "-") {
        if (id) throw new Error(`binrec: export takes one session id, got ${id} and ${arg}`);
        id = arg;
        continue;
      }
      args = args.slice(1);
      if (arg === "--output" || arg === "-o") {
        if (!value) throw new Error("binrec: --output needs a file");
        output = value;
      } else if (arg === "--format") {
        if (!videoFormats.includes(value as VideoFormat)) {
          throw new Error(`binrec: --format must be one of ${videoFormats.join(", ")}`);
        }
        format = value as VideoFormat;
      } else if (arg === "--speed") {
        speed = numberOf(arg, value);
        if (speed <= 0) throw new Error("binrec: --speed must be a number above 0");
      } else if (arg === "--fps") {
        fps = numberOf(arg, value);
        if (fps <= 0 || fps > 120) throw new Error("binrec: --fps must be a number above 0, up to 120");
      } else if (arg === "--max-pause") {
        maxPause = numberOf(arg, value);
        if (maxPause < 0) maxPause = Infinity;
      } else {
        throw new Error(`binrec: unknown option ${arg} for export\n\n${commandHelp.export!(b)}`);
      }
    }
    if (!id) {
      console.error(commandHelp.export!(b));
      return 1;
    }
    format ??= (output && formatOf(output)) || "mp4";
    output ??= `binrec-${id.slice(0, 8)}.${format}`;
    const result = await b.exportVideo(id, output, { format, speed, fps, maxPause, overwrite });
    console.log(
      `Exported ${result.output}: ${result.format}, ${result.width}×${result.height}, ${result.duration.toFixed(1)} s`,
    );
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
      process.exit(await init(b));
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
    case "export":
      process.exit(await exportSession(b, rest));
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
