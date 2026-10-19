import { test, expect, beforeAll, afterAll } from "bun:test";
import { $ } from "bun";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const binrec = new URL("../bin/binrec.ts", import.meta.url).pathname;

let tmp: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "binrec-shim-flag-"));
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** The `command` line of every record in `records`, by command path. */
const commandLines = async (records: string) => {
  const files = (await readdir(records)).filter((file) => file.endsWith(".ndjson"));
  const lines = await Promise.all(
    files.map(async (file) => JSON.parse((await Bun.file(join(records, file)).text()).split("\n")[0]!)),
  );
  return new Map(lines.map((line) => [line.command as string, line]));
};

test("--shim records only the listed commands run inside the session", async () => {
  const records = join(tmp, "only");
  const script = "date +%Y >/dev/null; ls / >/dev/null; echo hi | cat; uname >/dev/null; echo $PATH";
  const result = await $`bun ${binrec} rec --records ${records} --shim date,ls --shim cat sh -c ${script}`
    .env({ ...process.env, BINREC_HOME: join(tmp, "home") })
    .quiet();
  expect(result.stdout.toString()).toStartWith("hi\n");

  const lines = await commandLines(records);
  const sh = lines.get(Bun.which("sh")!);
  expect(sh.shims).toEqual(["date", "ls", "cat"]);
  for (const command of ["date", "ls", "cat"]) {
    expect(lines.get(Bun.which(command)!)?.parent).toBe(sh.sessionId);
  }
  expect(lines.has(Bun.which("uname")!)).toBe(false);
  expect(lines.size).toBe(4);

  // The shim folder goes first in the program's PATH and is removed afterwards.
  const shimDir = result.stdout.toString().split("\n")[1]!.split(":")[0]!;
  expect(shimDir).toContain("binrec-shims-");
  expect(await Bun.file(join(shimDir, "date")).exists()).toBe(false);
});

test("--shim skips a shim from binrec install, so each run is recorded once", async () => {
  const home = join(tmp, "installed");
  const env = { ...process.env, BINREC_HOME: home, PATH: `${join(home, "bin")}:${process.env.PATH}` };
  await $`bun ${binrec} install date`.env(env).quiet();

  const records = join(tmp, "installed-records");
  await $`bun ${binrec} rec --records ${records} --shim date sh -c ${"date >/dev/null"}`.env(env).quiet();

  const lines = await commandLines(records);
  expect(lines.size).toBe(2);
  expect(lines.has(Bun.which("date")!)).toBe(true);
  // The installed shim was not run: it would have recorded in its own folder.
  expect(await readdir(join(home, "records")).catch(() => [])).toEqual([]);
});

test("--shim with a command that does not exist runs nothing", async () => {
  const records = join(tmp, "missing");
  const result = await $`bun ${binrec} rec --records ${records} --shim binrec-no-such-command true`
    .nothrow()
    .quiet();
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("--shim binrec-no-such-command: command not found");
  expect(await readdir(records).catch(() => [])).toEqual([]);
});
