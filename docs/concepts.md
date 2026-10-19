# binrec concepts

This page explains the ideas behind binrec: what a shim and a session are, how binrec sits between your terminal and the programs it records, which environment variables it reads and sets, and how to install and remove it. For the full list of commands and the record format, see the [README](../README.md).

- [Shim](#shim)
- [Session](#session)
- [Nested session](#nested-session)
- [How binrec works with your terminal](#how-binrec-works-with-your-terminal)
- [Environment variables](#environment-variables)
- [Installing and uninstalling a shim](#installing-and-uninstalling-a-shim)
- [Installing and uninstalling binrec globally](#installing-and-uninstalling-binrec-globally)

## Shim

A shim is a tiny executable script with the same name as the program it stands in for. binrec puts its shims in one folder, `~/.binrec/bin`, and that folder goes first in your `PATH`. When you type `date`, the shell looks through `PATH` in order, finds `~/.binrec/bin/date` before `/usr/bin/date`, and runs the shim instead of the real program.

`binrec install date` writes a shim like this (paths vary with your system):

```sh
#!/bin/sh
exec '/home/me/.bun/bin/bun' '/home/me/.bun/install/global/node_modules/@jondotsoy/binrec/binrec.js' rec --records '/home/me/.binrec/records' --config '/home/me/.binrec/config.json' '/usr/bin/date' "$@"
```

Everything in it is an absolute path, fixed when the shim is written:

- the Bun runtime and the binrec script that installed the shim,
- the records folder and `config.json`,
- the real program (`/usr/bin/date`), found by looking it up in `PATH` while skipping the shim folder, so a shim never points at itself.

The shim hands every argument (`"$@"`) to `binrec rec`, which runs the real program and records it. `exec` replaces the shell with binrec, so no extra process stays around. The program gets the same arguments, input and output as without the shim, and `binrec rec` exits with the program's exit code, so scripts that use it behave as before.

Because the paths are fixed, a shim keeps working when you open a new shell or change `BINREC_HOME`, but it stops working if the binrec script it points at is deleted (see [Installing binrec globally](#installing-and-uninstalling-binrec-globally)).

Shims start with `#!/bin/sh` followed by `exec `, and binrec only removes files that look like that. Anything else you put in the shim folder is left alone.

## Session

A session is one run of a recorded program: everything from the moment binrec starts it until it exits. Each session gets a random id (a UUID such as `e531b87f-3f0c-4b7e-9a51-2c8d0f6a4e21`) and two files in `~/.binrec/records`:

| File | What it holds |
| --- | --- |
| `<sessionId>.ndjson` | One JSON line per event: the `command` line (binary, arguments, pid), every `stdin`, `stdout` and `stderr` chunk, `resize` and `signal` lines, and the `end` line with the exit code. See [Record format](../README.md#record-format). |
| `<sessionId>.stats.json` | `{ sessionId, command, total }`, written when the session ends, so `binrec stats` does not have to read every record. |

Both files are created with mode `0600`, so only you can read them.

You work with sessions through their id:

```sh
binrec list            # every session, oldest first, with its id
binrec list date       # only the sessions of date
binrec play e531b87f   # play one back; the start of the id is enough
binrec play --ui e531b87f
```

A session is recorded only while recording is on. `binrec off` turns it off for every shim (it writes `"recording": false` to `config.json`): the shims still run the real programs, but no session files are written. `binrec on` turns it back on.

## Nested session

A nested session is a session that starts inside another one, because the recorded program runs another recorded program. If you have shims for both `sh` and `date`:

```sh
binrec install sh
binrec install date
sh -c 'date +%F'
```

the outer `sh` is one session, and the `date` it runs goes through its own shim and becomes a second session. Each one has its own id and its own record: the `date` output shows up in the `date` session and, since it went through `sh`'s stdout, in the `sh` session too.

binrec counts how deep each session is with two environment variables it passes to the program it runs, each one more than its own:

- `BINREC_DEPTH` counts every binrec session the process runs inside. In the example, `sh` gets `BINREC_DEPTH=1` and `date` gets `BINREC_DEPTH=2`.
- `BINREC_DEPTH_<COMMAND>` counts only the sessions of that command. `sh` gets `BINREC_DEPTH_SH=1`; `date` gets `BINREC_DEPTH_DATE=1` (and still sees `BINREC_DEPTH_SH=1` from its parent).

Only the per-command counter has a limit. When a session's `BINREC_DEPTH_<COMMAND>` has already reached `maxDepth` in `config.json` (default `10`), binrec prints an error and exits with code 1 without running the program. This stops a shim that ends up calling itself, for example through a symlinked `PATH` entry, instead of starting sessions forever. Different recorded commands can call each other at any depth, because `BINREC_DEPTH` has no limit.

## How binrec works with your terminal

binrec does not hook into your shell. The integration is just `PATH`:

1. `binrec init` creates the shim folder and **prints** the lines to add to your shell's startup file. It does not change any file.

   ```console
   $ binrec init
   binrec bin directory ready: /home/me/.binrec/bin

   Add it to the start of your PATH by appending these lines to ~/.bashrc:

     export PATH="$HOME/.binrec/bin:$PATH"

   Then reload your shell with: source ~/.bashrc
   ```

   When `BINREC_HOME` is not the default `~/.binrec`, it prints an `export BINREC_HOME=…` line too.

2. You copy those lines into `~/.bashrc`, `~/.zshrc` or your shell's startup file and reload it (`source ~/.bashrc`) or open a new terminal.
3. From then on, every program with a shim is found in `~/.binrec/bin` first, and runs through `binrec rec`.

Commands you call with a full path (`/usr/bin/date`) skip `PATH`, so they are never recorded. To check which one a name resolves to, run `command -v date`: it prints the shim's path (`/home/me/.binrec/bin/date`) when the shim is active.

Once a shim runs, `binrec rec` decides how to connect the program to your terminal:

- **Interactive (pseudo terminal).** When both stdin and stdout are a terminal, binrec runs the program on its own pseudo terminal (pty) of the same size, and puts your terminal in raw mode so every key (Ctrl+C, arrows, Esc) reaches the program. Full-screen and interactive programs such as `vim`, `less`, `top` or `docker exec -it` keep working. Every key you type is recorded as `stdin` and everything the program draws as `stdout`; a terminal mixes stdout and stderr, so there are no `stderr` lines. Window size changes are passed on and recorded as `resize` lines. The pty uses your `TERM` (or `xterm-256color` when it is not set).
- **Pipes.** When stdin or stdout is not a terminal (`date | cat`, `date > out.txt`, CI), binrec connects the program with pipes and keeps `stdout` and `stderr` apart in the record.

Either way, binrec passes signals on: `SIGTERM` and `SIGHUP` (a `kill`, a closed terminal) always go to the program, and on a pty `SIGINT` and `SIGQUIT` (Ctrl+C, Ctrl+\\) do too; with pipes the program already gets those from the terminal. Each one is recorded as a `signal` line.

## Environment variables

| Variable | Read or set | What it does |
| --- | --- | --- |
| `BINREC_HOME` | Read by the `binrec` CLI and library | The folder binrec uses instead of `~/.binrec`: shims in `$BINREC_HOME/bin`, records in `$BINREC_HOME/records`, settings in `$BINREC_HOME/config.json`. Set it in your startup file (`binrec init` prints the line) so every new shell uses the same folder. Shims already installed keep the paths they were written with. |
| `PATH` | Read | The shim folder must come before the real binaries for the shims to take over. When installing a shim, binrec looks the program up in `PATH` without the shim folder. |
| `BINREC_DEPTH` | Set for the recorded program, read by binrec | How many binrec sessions the program runs inside, counting every command. No limit. See [Nested session](#nested-session). |
| `BINREC_DEPTH_<COMMAND>` | Set for the recorded program, read by binrec | How many sessions of `<COMMAND>` the program runs inside. `<COMMAND>` is the binary's name upper-cased, with every character other than a letter or digit turned into `_` (`date` → `BINREC_DEPTH_DATE`, `docker-compose` → `BINREC_DEPTH_DOCKER_COMPOSE`). At `maxDepth` binrec refuses to start another one. |
| `TERM` | Read | The terminal type given to the pseudo terminal in interactive sessions (default `xterm-256color`). |

The recorded program gets the rest of your environment unchanged.

Settings that are not environment variables live in `config.json`:

```json
{ "recording": true, "maxDepth": 10 }
```

## Installing and uninstalling a shim

Install a shim for a program on your `PATH`, or for an absolute path:

```sh
binrec install date
binrec install /opt/tool/bin/tool
binrec on date          # same as install
```

The shim is named after the program (`~/.binrec/bin/date`). Installing again rewrites it, which is how you point a shim at a new binrec version or a moved binary. If the program is not found, `install` fails and writes nothing.

Remove one shim, or every shim:

```sh
binrec uninstall date
binrec uninstall --all
binrec off date         # same as uninstall date
```

Uninstalling only deletes the shim. Recorded sessions stay in `~/.binrec/records`, so `binrec list` and `binrec play` still work with them. The same works from code with `b.install("date")`, `b.uninstall("date")` and `b.uninstallAll()`.

To keep the shims but stop recording for a while, use `binrec off` and `binrec on` without a program name.

## Installing and uninstalling binrec globally

binrec needs [Bun](https://bun.sh). Install the CLI globally:

```sh
bun add -g @jondotsoy/binrec
binrec init                       # then add the printed lines to ~/.bashrc
binrec install date
```

You can also run binrec without installing it, with `bunx`:

```sh
bunx @jondotsoy/binrec init
```

That is fine for `init`, `list`, `play` and `stats`, but install shims from a global install: a shim points at the binrec script that wrote it, and with `bunx` that script lives in a temporary folder (such as `/tmp/bunx-…`) that can be removed at any time, which breaks the shim. If you installed shims with `bunx`, run `binrec install <bin>` again after installing globally to rewrite them.

To update, install the new version and run `binrec install <bin>` again for each shim, so it points at the new script.

To uninstall binrec completely, remove things in this order, so no shim is left pointing at a binrec that is gone:

```sh
binrec uninstall --all            # 1. remove every shim
bun remove -g @jondotsoy/binrec   # 2. remove the CLI
```

3. Delete the `export PATH="$HOME/.binrec/bin:$PATH"` line (and `BINREC_HOME`, if you added it) from your shell's startup file.
4. If you do not want the recorded sessions or settings anymore, delete the folder: `rm -rf ~/.binrec` (or `$BINREC_HOME`). Records can contain secrets, so this is also how you get rid of them.
