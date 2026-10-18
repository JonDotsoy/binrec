import { test, expect, beforeAll, afterAll } from "bun:test";
import { $ } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const binrec = new URL("../bin/binrec.ts", import.meta.url).pathname;

let binrecHome: string;

beforeAll(async () => {
  binrecHome = await mkdtemp(join(tmpdir(), "binrec-help-"));
});

afterAll(async () => {
  await rm(binrecHome, { recursive: true, force: true });
});

const run = (args: string[]) =>
  $`bun ${binrec} ${args}`.env({ ...process.env, BINREC_HOME: binrecHome }).nothrow().quiet();

const commands = [
  "binrec help",
  "binrec --version",
  "binrec install",
  "binrec install <bin>",
  "binrec uninstall <bin>",
  "binrec uninstall --all",
  "binrec on",
  "binrec off",
  "binrec on <bin>",
  "binrec off <bin>",
  "binrec enable",
  "binrec disable",
  "binrec stats",
  "binrec rec",
];

for (const args of [["help"], ["--help"], ["-h"], []]) {
  test(`binrec ${args.join(" ")} lists every command and exits with 0`, async () => {
    const result = await run(args);

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    const stdout = result.stdout.toString();
    for (const command of commands) expect(stdout).toContain(command);
  });
}

test("binrec help <command> shows the help of that command", async () => {
  const result = await run(["help", "rec"]);

  expect(result.exitCode).toBe(0);
  const stdout = result.stdout.toString();
  expect(stdout).toContain("Usage: binrec rec");
  expect(stdout).toContain("--records <dir>");
  expect(stdout).toContain(join(binrecHome, "records"));
});

test("binrec help resolves aliases to their command", async () => {
  for (const [alias, usage] of [
    ["enable", "Usage: binrec on"],
    ["disable", "Usage: binrec off"],
    ["-v", "Usage: binrec --version"],
    ["--help", "Usage: binrec help"],
  ] as const) {
    const result = await run(["help", alias]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain(usage);
  }
});

test("binrec <command> --help shows its help without running it", async () => {
  for (const [command, usage] of [
    ["install", "Usage: binrec install"],
    ["uninstall", "Usage: binrec uninstall"],
    ["off", "Usage: binrec off"],
    ["stats", "Usage: binrec stats"],
    ["rec", "Usage: binrec rec"],
  ] as const) {
    for (const flag of ["--help", "-h"]) {
      const result = await run([command, flag]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain(usage);
    }
  }

  // Nothing was installed or toggled.
  expect(await Bun.file(join(binrecHome, "bin", "--help")).exists()).toBe(false);
  expect(await Bun.file(join(binrecHome, "config.json")).exists()).toBe(false);
});

test("binrec help <unknown> fails with 1 and says so", async () => {
  const result = await run(["help", "nope"]);

  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("binrec: unknown command nope");
});

test("an unknown command fails with 1 and shows the usage on stderr", async () => {
  const result = await run(["nope"]);

  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString()).toBe("");
  const stderr = result.stderr.toString();
  expect(stderr).toContain("binrec: unknown command nope");
  expect(stderr).toContain("binrec help [<command>]");
});
