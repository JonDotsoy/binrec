import { test, expect, beforeAll, afterAll } from "bun:test";
import { $ } from "bun";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { binrec } from "../index.ts";

const binrecBin = new URL("../bin/binrec.ts", import.meta.url).pathname;

let tmp: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "binrec-signals-"));
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const readLines = async (records: string) => {
  const [file] = (await readdir(records)).filter((f) => f.endsWith(".ndjson"));
  if (!file) return [];
  return (await Bun.file(join(records, file)).text())
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
};

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("the command line records the pid of the program", async () => {
  const records = join(tmp, "pid");
  const result = await $`${process.execPath} ${binrecBin} rec --records ${records} sh -c ${"echo $$"}`.quiet();

  const [command] = await readLines(records);
  expect(command.type).toBe("command");
  expect(command.pid).toBe(Number(result.stdout.toString().trim()));
});

test("SIGTERM to binrec stops the program and the session still ends", async () => {
  const records = join(tmp, "sigterm");
  const proc = Bun.spawn([process.execPath, binrecBin, "rec", "--records", records, "sleep", "30"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });

  let pid: number | undefined;
  for (let i = 0; i < 100 && pid === undefined; i++) {
    await Bun.sleep(50);
    pid = (await readLines(records).catch(() => []))[0]?.pid;
  }
  expect(pid).toBeNumber();

  proc.kill("SIGTERM");
  const exitCode = await proc.exited;

  expect(exitCode).toBe(143);
  expect(isRunning(pid!)).toBe(false);

  const lines = await readLines(records);
  expect(lines.find((line) => line.type === "signal")).toMatchObject({ signal: "SIGTERM" });
  expect(lines.at(-1)).toMatchObject({ type: "end", exitCode: 143 });

  const b = binrec.create({ path: join(tmp, "bin"), records });
  expect((await b.stats()).sessions).toBe(1);
});
