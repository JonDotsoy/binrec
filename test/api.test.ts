import { test, expect, beforeAll, afterAll } from "bun:test";
import { $ } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { binrec } from "../index.ts";

let tmp: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "binrec-api-"));
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

test("binrec.create uses the given path", () => {
  const b = binrec.create({ path: join(tmp, "bin") });
  expect(b.path).toBe(join(tmp, "bin"));
});

test("b.install(date) lets Bun.$ run date through the shim", async () => {
  const b = binrec.create({ path: join(tmp, "bin") });
  const shimPath = await b.install("date");

  expect(shimPath).toBe(join(b.path, "date"));

  const env = { ...process.env, PATH: `${b.path}:${process.env.PATH}` };

  const which = await $`which date`.env(env).quiet();
  expect(which.stdout.toString().trim()).toBe(shimPath);

  const result = await $`date +%Y-%m-%d`.env(env).nothrow().quiet();
  const expected = await $`date +%Y-%m-%d`.quiet().text();

  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe(expected);
});

test("b.install rejects unknown commands", async () => {
  const b = binrec.create({ path: join(tmp, "bin") });
  await expect(b.install("binrec-no-such-command")).rejects.toThrow("command not found");
});
