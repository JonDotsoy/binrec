# binrec

Record everything a command reads and writes.

`binrec` puts a small shim in front of any binary on your `PATH`. Every time the binary runs, the shim passes stdin, stdout and stderr straight through to the real program and writes the whole session (arguments, every chunk of input and output, and the exit code) to an [ndjson](https://github.com/ndjson/ndjson-spec) file. You can use it from the command line or as a library, for example to check in tests exactly how your code called a tool.

Requires [Bun](https://bun.sh).

## Install

```sh
bun add -g @jondotsoy/binrec   # the binrec CLI
bun add @jondotsoy/binrec      # the library
```

## CLI

Create the shim folder (`~/.binrec/bin`) and see how to add it to your `PATH`:

```sh
binrec install
```

Install a shim for a binary:

```sh
binrec install date
```

`binrec` resolves the real path (for example `/usr/bin/date`) and writes an executable `~/.binrec/bin/date` that runs `binrec rec /usr/bin/date "$@"`.

For the shim to take over, its folder must come **before** the real binary in `PATH`:

```sh
export PATH="$HOME/.binrec/bin:$PATH"
```

From then on every `date` call is recorded in `~/.binrec/records/<sessionId>.ndjson`, and `date` behaves exactly as before: same output, same exit code.

You can also record a single run without installing a shim:

```sh
binrec rec /usr/bin/date +%F
binrec rec --records ./records /usr/bin/date +%F
```

| Command | What it does |
| --- | --- |
| `binrec install` | Creates the shim folder and prints the `PATH` line for `~/.bashrc`. |
| `binrec install <bin>` | Installs a shim for `<bin>`. |
| `binrec uninstall <bin>` | Removes the shim for `<bin>`. Its recorded sessions are kept. |
| `binrec rec [--records <dir>] <path> [args…]` | Runs `<path>`, passes stdio through, records the session and exits with its exit code. |
| `binrec --version` (`-v`) | Prints the binrec version. |

Set `BINREC_HOME` to use a folder other than `~/.binrec`.

## Record format

Each session is one ndjson file:

```ndjson
{"type":"command","sessionId":"8969d708-…","timestamp":"2026-10-18T04:05:14.936Z","performance":9.05,"command":"/usr/bin/date","args":["+%F"]}
{"type":"stdout","timestamp":"2026-10-18T04:05:14.949Z","performance":22.70,"data":"2026-10-18\n"}
{"type":"end","timestamp":"2026-10-18T04:05:14.950Z","performance":23.68,"exitCode":0}
```

- The first line (`command`) has the session id, the absolute path of the binary and its arguments.
- Each `stdin`, `stdout` and `stderr` line holds one chunk as text in `data`.
- If a chunk is not valid UTF-8 on its own, `data` is `null` and the raw bytes are in `data_base64`, so nothing is lost.
- On a terminal, `resize` lines hold the window size (`cols`, `rows`): one at the start and one each time the window changes.
- The last line (`end`) has the exit code.
- Records are private: each file is created with mode `0600` and a records folder binrec creates gets `0700`, so only the user who recorded a session can read it, whatever the `umask`.
- `timestamp` is wall-clock time (ISO 8601) and `performance` is `performance.now()` in the recording process.

## Library

```ts
import { $ } from "bun";
import { binrec } from "@jondotsoy/binrec";

const b = binrec.create({ path: "/tmp/my-bin" }); // path and records are optional
await b.install("date");

await $`date +%F`.env({ ...process.env, PATH: `${b.path}:${process.env.PATH}` });

const session = await b.lastSession("date");
session?.args;     // ["+%F"]
session?.exitCode; // 0
session?.lines;    // every ndjson line of the session
```

| API | Description |
| --- | --- |
| `binrec.create({ path?, records? })` | Creates an instance. `path` is the shim folder (default `~/.binrec/bin`), `records` the records folder (default `records` next to `path`). |
| `b.path`, `b.records` | Absolute paths of both folders. |
| `b.init()` | Creates the shim folder. |
| `b.install(command)` | Installs a shim for `command` and returns its path. Throws if the command is not found. |
| `b.uninstall(command)` | Removes the shim for `command` and returns its path, or `null` if there was none. Only removes files binrec wrote; records are kept. |
| `b.sessions(command)` | Every recorded session of `command`, oldest first. `command` can be a name (`date`) or an absolute path. |
| `b.lastSession(command)` | The most recent session of `command`, or `null`. |
| `b.disableRecords()` / `b.enableRecords()` | Turns recording off or on for every shim that uses this records folder. Shims keep working while recording is off. |
| `b.isRecording()` | `true` unless recording was turned off. |
| `binrec.rec(path, args, { records })` | Runs and records one command, like `binrec rec`. Pass `records: false` to run without recording. |

Each session has `sessionId`, `command`, `args`, `timestamp`, `exitCode` (`null` if it has not ended), `recordPath` and `lines`.

## Notes

- When you run it on a terminal, binrec gives the program its own pseudo terminal, so interactive programs such as `vim`, `less` or `docker exec -it` work while they are recorded. Every key you type is recorded as `stdin` and everything the program draws as `stdout` (a terminal mixes stdout and stderr, so there are no `stderr` lines in that case).
- When stdin or stdout is not a terminal (pipes, redirects, CI), binrec uses pipes and keeps stdout and stderr apart.
- Shims are bash scripts and point at the Bun runtime and the binrec script that installed them.

## Development

```sh
bun install
bun test        # tests use Bun.$ and snapshots; the date cases need GNU date
bun run build   # writes dist/binrec.js and dist/package.json
```

`dist/binrec.js` is both the library and the `binrec` bin. Only `dist/` is published; the root `package.json` is private.

Releases run from the **publish** GitHub Actions workflow (`workflow_dispatch`, with a `patch`, `minor` or `major` bump). It runs the tests, builds, publishes `dist/` to npm with trusted publishing (OIDC), tags the version and creates a GitHub release.

## Security

Records can contain secrets. See [SECURITY.md](SECURITY.md) for how records are protected and how to report a vulnerability.

## License

[MIT](LICENSE) © [Jonathan Delgado](https://jon.soy) <hi@jon.soy>
