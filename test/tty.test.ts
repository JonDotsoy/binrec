import { test, expect, beforeAll, afterAll } from "bun:test";
import { $ } from "bun";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { binrec } from "../index.ts";

const binrecBin = new URL("../bin/binrec.ts", import.meta.url).pathname;
const script = Bun.which("script");
const tty = Bun.which("tty");

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "binrec-tty-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Runs `binrec rec` inside a pseudo terminal created by util-linux `script`. */
const recInTty = async (records: string, ...command: string[]) => {
  const cmd = [process.execPath, binrecBin, "rec", "--records", records, ...command]
    .map((part) => `'${part}'`)
    .join(" ");
  const result = await $`${script!} -qec ${cmd} /dev/null`.nothrow().quiet();
  return { exitCode: result.exitCode, output: result.stdout.toString().replaceAll("\r\n", "\n") };
};

const canRun = Boolean(script && tty);

test.skipIf(!canRun)("the tty bin sees a terminal when run directly", async () => {
  const result = await $`${script!} -qec ${tty!} /dev/null`.nothrow().quiet();
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toMatch(/^\/dev\/pts\/\d+/);
});

test.skipIf(!canRun)("binrec rec records a tty bin through pipes, so it sees no terminal", async () => {
  const records = join(dir, "on");
  const { exitCode, output } = await recInTty(records, tty!);

  expect(exitCode).toBe(1);
  expect(output).toBe("not a tty\n");

  const session = await binrec.create({ path: join(dir, "bin"), records }).lastSession(tty!);
  expect(session?.exitCode).toBe(1);
  expect(session?.lines.filter((l) => l.type === "stdout").map((l) => ("data" in l ? l.data : undefined))).toEqual(["not a tty\n"]);
});

test.skipIf(!canRun)("binrec rec keeps the terminal while recording is off", async () => {
  const records = join(dir, "off");
  await mkdir(records, { recursive: true });
  await binrec.create({ path: join(dir, "bin"), records }).disableRecords();

  const { exitCode, output } = await recInTty(records, tty!);

  expect(exitCode).toBe(0);
  expect(output).toMatch(/^\/dev\/pts\/\d+\n$/);
});

test.skipIf(!canRun)("binrec rec runs a plain command on a terminal without hanging", async () => {
  const { exitCode, output } = await recInTty(join(dir, "date"), "/usr/bin/date", "+%Y");
  expect(exitCode).toBe(0);
  expect(output).toBe(`${new Date().getFullYear()}\n`);
});
