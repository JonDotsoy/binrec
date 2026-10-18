# Security Policy

## Supported versions

Security fixes are released for the latest published version of `@jondotsoy/binrec`. Please upgrade before reporting an issue.

Versions `0.0.1` to `0.0.3` are deprecated on npm: they create records that other users on the machine can read (see [Records from older versions](#records-from-older-versions)).

## Reporting a vulnerability

Please do **not** open a public issue for security problems.

Report them privately to Jonathan Delgado at [hi@jon.soy](mailto:hi@jon.soy), or through [GitHub's private vulnerability reporting](https://github.com/JonDotsoy/binrec/security/advisories/new). Include the binrec version, your OS, and the steps to reproduce.

You will get an answer within a few days. Once a fix is released, the report is credited in the release notes unless you prefer to stay anonymous.

## What binrec stores

binrec records everything a program reads and writes. Records may contain passwords, tokens or other secrets typed into or printed by the recorded program:

- **Arguments**, in plain text. A secret passed on the command line (`--password=…`, `-H "Authorization: Bearer …"`, `mysql -p…`) ends up in the record.
- **Every key you type**. On a terminal binrec records stdin even while the program hides what you type, so passwords typed at `ssh`, `sudo`, `git` or `npm login` prompts are recorded.
- **Everything the program prints**, and its exit code.

Environment variables are not recorded.

How records are protected:

- Each record is created with mode `0600` and records folders binrec creates get `0700`, so only the user who recorded a session can read it. A records folder that already existed keeps its permissions.
- Records are kept in `~/.binrec/records` (or the folder you choose) until you delete them. binrec never sends them anywhere.
- `binrec play --ui` serves the session on `127.0.0.1` without a password, so other users on the same machine can open it while it runs. Stop it with Ctrl+C when you are done.

To keep secrets out of records:

- Don't install shims for programs that handle secrets (`sudo`, `su`, `ssh`, `passwd`, `gpg`, password managers, cloud CLIs), or turn recording off while you use them with `binrec off` (`b.disableRecords()` in the library) and back on with `binrec on`.
- Review a record before you share it, for example in an issue or as a CI artifact, and delete records you no longer need.

## Records from older versions

binrec `0.0.1` to `0.0.3` wrote records with your `umask`, usually `0644`, so other users could read them. Upgrading does not change existing files. Make them private with:

```sh
chmod 700 ~/.binrec/records
chmod 600 ~/.binrec/records/*
```

## Shims and `PATH`

Shims work by going **before** the real binaries in `PATH`, so whoever can write to the shim folder (`~/.binrec/bin`) can run code as you every time you call a shimmed command. Keep that folder, and `~/.binrec`, writable only by you.

Each shim runs the Bun runtime and the binrec script that installed it. If you installed binrec with `bunx` or from a project's `node_modules`, the shims depend on files there; reinstall them from a global install (`bun add -g @jondotsoy/binrec`).

A shim that ends up calling itself (for example through a symlinked `PATH` entry) stops after `maxDepth` nested sessions of the same command (10 by default, set in `config.json`) instead of starting sessions forever. Shims installed with binrec `0.0.5` or older start with `#!/usr/bin/env bash`; a shim for `bash` written by those versions runs itself forever, so reinstall it.
