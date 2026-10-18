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

test("binrec --version prints the package version", async () => {
  const { version } = await Bun.file(new URL("../package.json", import.meta.url)).json();

  for (const flag of ["--version", "-v"]) {
    const result = await $`bun ${binrec} ${flag}`.nothrow().quiet();
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe(`${version}\n`);
  }
});

test("binrec uninstall date removes the shim and date runs the real binary again", async () => {
  const env = { ...process.env, BINREC_HOME: binrecHome };
  await $`bun ${binrec} install date`.env(env).quiet();

  const result = await $`bun ${binrec} uninstall date`.env(env).nothrow().quiet();
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe(`Uninstalled ${join(binDir, "date")}\n`);
  expect(await Bun.file(join(binDir, "date")).exists()).toBe(false);

  const which = await $`which date`.env({ ...env, PATH: `${binDir}:${process.env.PATH}` }).quiet();
  expect(which.stdout.toString().trim()).not.toBe(join(binDir, "date"));
});

test("binrec uninstall fails for a command without a shim", async () => {
  const result = await $`bun ${binrec} uninstall date`
    .env({ ...process.env, BINREC_HOME: binrecHome })
    .nothrow()
    .quiet();
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("no shim installed for date");
});

test("binrec uninstall --all removes every shim", async () => {
  const env = { ...process.env, BINREC_HOME: binrecHome };
  await $`bun ${binrec} install date`.env(env).quiet();
  await $`bun ${binrec} install true`.env(env).quiet();

  const result = await $`bun ${binrec} uninstall --all`.env(env).nothrow().quiet();
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe(
    `Uninstalled ${join(binDir, "date")}\nUninstalled ${join(binDir, "true")}\n`,
  );
  expect(await Bun.file(join(binDir, "date")).exists()).toBe(false);
  expect(await Bun.file(join(binDir, "true")).exists()).toBe(false);

  const again = await $`bun ${binrec} uninstall --all`.env(env).nothrow().quiet();
  expect(again.exitCode).toBe(0);
  expect(again.stdout.toString()).toBe(`No shims installed in ${binDir}\n`);
});

test("binrec off and on turn recording off and back on", async () => {
  const env = { ...process.env, BINREC_HOME: binrecHome };
  const marker = join(binrecHome, "records", ".disabled");

  const off = await $`bun ${binrec} off`.env(env).nothrow().quiet();
  expect(off.exitCode).toBe(0);
  expect(off.stdout.toString()).toContain("Recording is off");
  expect(await Bun.file(marker).exists()).toBe(true);

  const on = await $`bun ${binrec} on`.env(env).nothrow().quiet();
  expect(on.exitCode).toBe(0);
  expect(on.stdout.toString()).toContain("Recording is on");
  expect(await Bun.file(marker).exists()).toBe(false);

  await $`bun ${binrec} disable`.env(env).quiet();
  expect(await Bun.file(marker).exists()).toBe(true);
  await $`bun ${binrec} enable`.env(env).quiet();
  expect(await Bun.file(marker).exists()).toBe(false);
});

test("binrec on <bin> and off <bin> install and uninstall the shim", async () => {
  const env = { ...process.env, BINREC_HOME: binrecHome };

  const on = await $`bun ${binrec} on date`.env(env).nothrow().quiet();
  expect(on.exitCode).toBe(0);
  expect(on.stdout.toString()).toBe(`Installed ${join(binDir, "date")}\n`);
  expect(await Bun.file(join(binDir, "date")).exists()).toBe(true);

  const off = await $`bun ${binrec} off date`.env(env).nothrow().quiet();
  expect(off.exitCode).toBe(0);
  expect(off.stdout.toString()).toBe(`Uninstalled ${join(binDir, "date")}\n`);
  expect(await Bun.file(join(binDir, "date")).exists()).toBe(false);
  // Only the shim went away; recording itself stays on.
  expect(await Bun.file(join(binrecHome, "records", ".disabled")).exists()).toBe(false);
});
