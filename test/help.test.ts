import { test, expect, beforeAll, afterAll } from "bun:test";
import { $ } from "bun";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const binrec = new URL("../bin/binrec.ts", import.meta.url).pathname;

let binrecHome: string;
let env: Record<string, string | undefined>;

beforeAll(async () => {
  binrecHome = await mkdtemp(join(tmpdir(), "binrec-help-"));
  env = { ...process.env, BINREC_HOME: binrecHome };
});

afterAll(async () => {
  await rm(binrecHome, { recursive: true, force: true });
});

test("binrec --help and -h print the usage to stdout", async () => {
  for (const flag of ["--help", "-h"]) {
    const result = await $`bun ${binrec} ${flag}`.env(env).nothrow().quiet();
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toStartWith("Usage:\n");
    expect(result.stdout.toString()).toContain("binrec list [<bin>]");
  }
});

test("every command shows its help with --help or -h instead of running", async () => {
  const commands = ["install", "uninstall", "on", "enable", "off", "disable", "stats", "rec", "list", "play"];
  for (const command of commands) {
    for (const flag of ["--help", "-h"]) {
      const result = await $`bun ${binrec} ${command} ${flag}`.env(env).nothrow().quiet();
      const name = command === "enable" ? "on" : command === "disable" ? "off" : command;
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toStartWith(`Usage: binrec ${name}`);
    }
  }
  // Nothing was installed, toggled or recorded.
  expect(await readdir(binrecHome)).toEqual([]);
});

test("binrec rec passes --help on to the program when it is not the only argument", async () => {
  const sh = Bun.which("sh")!;
  const script = 'printf "%s\\n" "$1"';
  const result = await $`bun ${binrec} rec ${sh} -c ${script} sh --help`.env(env).nothrow().quiet();
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe("--help\n");

  const flagFirst = await $`bun ${binrec} rec --help ${sh}`.env(env).nothrow().quiet();
  expect(flagFirst.stdout.toString()).not.toStartWith("Usage: binrec rec");
});
