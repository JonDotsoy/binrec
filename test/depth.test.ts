import { test, expect, beforeAll, afterAll } from "bun:test";
import { $ } from "bun";
import { mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const binrec = new URL("../bin/binrec.ts", import.meta.url).pathname;

let tmp: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "binrec-depth-"));
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const countRecords = async (records: string) =>
  (await readdir(records).catch(() => [] as string[])).filter((file) => file.endsWith(".ndjson")).length;

test("a shim that calls itself stops at maxDepth", async () => {
  const home = join(tmp, "loop");
  const link = join(tmp, "loop-link");
  await $`bun ${binrec} install`.env({ ...process.env, BINREC_HOME: home }).quiet();
  await symlink(join(home, "bin"), link);
  const env = { ...process.env, BINREC_HOME: home, PATH: `${link}:${process.env.PATH}` };

  // The second install finds the first shim through the symlink and points at it.
  await $`bun ${binrec} install date`.env(env).quiet();
  await $`bun ${binrec} install date`.env(env).quiet();
  expect(await Bun.file(join(home, "bin", "date")).text()).toContain(`'${join(link, "date")}'`);

  const result = await $`timeout 30 date +%Y`.env(env).nothrow().quiet();
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("10 binrec sessions are already nested (maxDepth 10)");
  expect(await countRecords(join(home, "records"))).toBe(10);
});

test("maxDepth in config.json sets the limit", async () => {
  const home = join(tmp, "config");
  const config = join(home, "config.json");
  const records = join(home, "records");
  await Bun.write(config, `${JSON.stringify({ maxDepth: 2 })}\n`);
  const rec = (depth: string) =>
    $`bun ${binrec} rec --records ${records} --config ${config} sh -c ${"echo $BINREC_DEPTH"}`
      .env({ ...process.env, BINREC_DEPTH: depth })
      .nothrow()
      .quiet();

  const inside = await rec("1");
  expect(inside.exitCode).toBe(0);
  expect(inside.stdout.toString()).toBe("2\n");

  const past = await rec("2");
  expect(past.exitCode).toBe(1);
  expect(past.stdout.toString()).toBe("");
  expect(past.stderr.toString()).toContain("2 binrec sessions are already nested (maxDepth 2)");
  expect(await countRecords(records)).toBe(1);
});

test("a shim for bash runs the real bash", async () => {
  const home = join(tmp, "bash");
  const env = { ...process.env, BINREC_HOME: home };
  await $`bun ${binrec} install bash`.env(env).quiet();
  expect(await Bun.file(join(home, "bin", "bash")).text()).toStartWith("#!/bin/sh\n");

  const result = await $`timeout 30 bash -c ${"echo hi"}`
    .env({ ...env, PATH: `${join(home, "bin")}:${process.env.PATH}` })
    .nothrow()
    .quiet();
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe("hi\n");
  expect(await countRecords(join(home, "records"))).toBe(1);
});

test("binrec uninstall removes shims written with the old bash header", async () => {
  const home = join(tmp, "legacy");
  const shim = join(home, "bin", "date");
  await Bun.write(shim, `#!/usr/bin/env bash\nexec 'bun' 'binrec.ts' rec --records 'r' --config 'c' '/usr/bin/date' "$@"\n`);

  const result = await $`bun ${binrec} uninstall date`.env({ ...process.env, BINREC_HOME: home }).nothrow().quiet();
  expect(result.exitCode).toBe(0);
  expect(await Bun.file(shim).exists()).toBe(false);
});
