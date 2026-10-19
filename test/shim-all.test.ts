import { test, expect, beforeAll, afterAll } from "bun:test";
import { $ } from "bun";
import { chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const binrec = new URL("../bin/binrec.ts", import.meta.url).pathname;

let tmp: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "binrec-shim-all-"));
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** The `command` line of every record in `records`. */
const commandLines = async (records: string) => {
  const files = (await readdir(records)).filter((file) => file.endsWith(".ndjson"));
  return Promise.all(
    files.map(async (file) => JSON.parse((await Bun.file(join(records, file)).text()).split("\n")[0]!)),
  );
};

const env = () => ({ ...process.env, BINREC_HOME: join(tmp, "home") });

test("--shim-all records every command the program finds in PATH", async () => {
  const records = join(tmp, "all");
  const script = "date +%Y >/dev/null; echo a/b | sed s/a/x/ | grep x; uname >/dev/null; echo $PATH";
  const result = await $`bun ${binrec} rec --records ${records} --shim-all sh -c ${script}`.env(env()).quiet();
  const [out, path] = result.stdout.toString().split("\n");
  expect(out).toBe("x/b");

  const lines = await commandLines(records);
  const sh = lines.find((line) => line.command === Bun.which("sh"))!;
  expect(sh.shimAll).toBe(true);
  const nested = lines.filter((line) => line.parent === sh.sessionId).map((line) => line.command).sort();
  expect(nested).toEqual(["date", "grep", "sed", "uname"].map((name) => Bun.which(name)!).sort());

  // The folder holds one link per name and is removed after the session.
  const shimDir = path!.split(":")[0]!;
  expect(shimDir).toContain("binrec-shims-");
  expect(await Bun.file(join(shimDir, "date")).exists()).toBe(false);
});

test("--shim-all finds the command in the PATH the program has when it runs it", async () => {
  // Like a Python venv: the program puts its own folder first after binrec started.
  const venv = join(tmp, "venv");
  await mkdir(venv, { recursive: true });
  await Bun.write(join(venv, "uname"), "#!/bin/sh\necho from-venv\n");
  await chmod(join(venv, "uname"), 0o755);

  const records = join(tmp, "venv-records");
  const script = `PATH="$(printf %s "$PATH" | cut -d: -f1):${venv}:$(printf %s "$PATH" | cut -d: -f2-)" uname`;
  const result = await $`bun ${binrec} rec --records ${records} --shim-all sh -c ${script}`.env(env()).quiet();
  expect(result.stdout.toString()).toBe("from-venv\n");
  const lines = await commandLines(records);
  expect(lines.some((line) => line.command === join(venv, "uname"))).toBe(true);
});

test("--shim-all leaves out the default exclusions and --no-shim", async () => {
  const records = join(tmp, "excluded");
  await $`bun ${binrec} rec --records ${records} --shim-all --no-shim date,uname sh -c ${"date >/dev/null; uname >/dev/null; tty >/dev/null; true"}`
    .env(env())
    .nothrow()
    .quiet();
  const commands = (await commandLines(records)).map((line) => line.command);
  expect(commands).toEqual([Bun.which("sh")]);
});

test("--shim-all skips shims from binrec install, so each run is recorded once", async () => {
  const home = join(tmp, "installed");
  const installedEnv = { ...process.env, BINREC_HOME: home, PATH: `${join(home, "bin")}:${process.env.PATH}` };
  await $`bun ${binrec} install date`.env(installedEnv).quiet();

  const records = join(tmp, "installed-records");
  await $`bun ${binrec} rec --records ${records} --shim-all sh -c ${"date >/dev/null"}`.env(installedEnv).quiet();
  expect((await commandLines(records)).map((line) => line.command).sort()).toEqual(
    [Bun.which("date", { PATH: process.env.PATH })!, Bun.which("sh")!].sort(),
  );
  expect(await readdir(join(home, "records")).catch(() => [])).toEqual([]);
});
