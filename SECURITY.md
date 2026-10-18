# Security Policy

## Supported versions

Security fixes are released for the latest published version of `@jondotsoy/binrec`. Please upgrade before reporting an issue.

## Reporting a vulnerability

Please do **not** open a public issue for security problems.

Report them privately to Jonathan Delgado at [hi@jon.soy](mailto:hi@jon.soy), or through [GitHub's private vulnerability reporting](https://github.com/JonDotsoy/binrec/security/advisories/new). Include the binrec version, your OS, and the steps to reproduce.

You will get an answer within a few days. Once a fix is released, the report is credited in the release notes unless you prefer to stay anonymous.

## What binrec stores

binrec records everything a program reads and writes: arguments, keystrokes, output and exit codes. Records may contain passwords, tokens or other secrets typed into or printed by the recorded program.

- Each record is created with mode `0600` and records folders binrec creates get `0700`, so only the user who recorded a session can read it.
- Records are kept in `~/.binrec/records` (or the folder you choose) until you delete them. binrec never sends them anywhere.
- Avoid installing shims for programs that handle secrets, or turn recording off with `b.disableRecords()` while you use them.
