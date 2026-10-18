import { test, expect, beforeAll, afterAll } from "bun:test";
import { $ } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const binrec = new URL("../bin/binrec.ts", import.meta.url).pathname;

let binrecHome: string;
let binDir: string;

beforeAll(async () => {
  binrecHome = await mkdtemp(join(tmpdir(), "binrec-"));
  binDir = join(binrecHome, "bin");
});

afterAll(async () => {
  await rm(binrecHome, { recursive: true, force: true });
});

test("binrec install creates the bin dir and shows the PATH line", async () => {
  const result = await $`bun ${binrec} install`
    .env({ ...process.env, BINREC_HOME: binrecHome })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain(`export PATH="$PATH:${binDir}"`);
  expect(await Bun.file(binDir).stat().then((s) => s.isDirectory())).toBe(true);
});

test("binrec install date creates an executable shim", async () => {
  const result = await $`bun ${binrec} install date`
    .env({ ...process.env, BINREC_HOME: binrecHome })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(0);
  expect(await Bun.file(join(binDir, "date")).exists()).toBe(true);
});

test("date runs through the binrec shim", async () => {
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const which = await $`which date`.env(env).quiet();
  expect(which.stdout.toString().trim()).toBe(join(binDir, "date"));

  const result = await $`echo "date $(date +%Y-%m-%d)" | cat`.env(env).nothrow().quiet();
  const expected = await $`date +%Y-%m-%d`.quiet().text();

  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe(`date ${expected}`);
});
