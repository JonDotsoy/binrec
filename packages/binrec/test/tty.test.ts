import { test, expect, beforeAll, afterAll } from "bun:test";
import { $ } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { binrec } from "../index.ts";

const binrecBin = new URL("../bin/binrec.ts", import.meta.url).pathname;
const script = Bun.which("script");
const tty = Bun.which("tty");
const vim = Bun.which("vim");

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "binrec-tty-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const quote = (part: string) => `'${part.replaceAll("'", `'\\''`)}'`;

/**
 * Runs `command` inside a pseudo terminal created by util-linux `script`, typing
 * `input` into it after a short pause so the program is ready to read it.
 *
 * `script`'s stdin stays open until the program exits: once it ends, `script`
 * types an EOF (^D) into the terminal, which a slow program would still read.
 */
const inTty = async (command: string[], input = "") => {
  const proc = Bun.spawn([script!, "-qec", command.map(quote).join(" "), "/dev/null"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  const output = new Response(proc.stdout).text();
  await Bun.sleep(500);
  proc.stdin.write(input);
  await proc.stdin.flush();
  const exitCode = await proc.exited;
  await proc.stdin.end();
  return { exitCode, output: await output };
};

const rec = (records: string, ...command: string[]) => [
  process.execPath,
  binrecBin,
  "rec",
  "--records",
  records,
  ...(command[0] === "--config" ? command.splice(0, 2) : []),
  ...command,
];

const stdoutOf = (lines: { type: string }[]) =>
  lines
    .filter((l) => l.type === "stdout")
    .map((l) => ("data" in l ? l.data : ""))
    .join("");

const canRun = Boolean(script && tty);

test.skipIf(!canRun)("binrec rec runs a tty bin on a terminal and records it", async () => {
  const records = join(dir, "tty");
  const { exitCode, output } = await inTty(rec(records, tty!));

  expect(exitCode).toBe(0);
  expect(output).toMatch(/^\/dev\/pts\/\d+\r+\n/);

  const session = await binrec.create({ path: join(dir, "bin"), records }).lastSession(tty!);
  expect(session?.exitCode).toBe(0);
  expect(stdoutOf(session!.lines)).toMatch(/^\/dev\/pts\/\d+\r\n/);
  expect(session?.lines[1]).toMatchObject({ type: "resize", cols: expect.any(Number), rows: expect.any(Number) });
});

test.skipIf(!canRun)("binrec rec passes the exit code through on a terminal", async () => {
  const { exitCode } = await inTty(rec(join(dir, "exit"), "/bin/sh", "-c", "exit 7"));
  expect(exitCode).toBe(7);
});

test.skipIf(!canRun || !vim)("vim works while it is recorded", async () => {
  const records = join(dir, "vim");
  const file = join(dir, "note.txt");
  const { exitCode } = await inTty(rec(records, vim!, "-u", "NONE", "-n", file), "ihola\x1b:wq\r");

  expect(exitCode).toBe(0);
  expect(await Bun.file(file).text()).toBe("hola\n");

  const session = await binrec.create({ path: join(dir, "bin"), records }).lastSession("vim");
  const typed = session!.lines
    .filter((l) => l.type === "stdin")
    .map((l) => ("data" in l ? l.data : ""))
    .join("");
  expect(typed).toBe("ihola\x1b:wq\r");
  expect(session?.exitCode).toBe(0);
});

test.skipIf(!canRun)("binrec rec keeps the terminal while recording is off", async () => {
  const records = join(dir, "off");
  const b = binrec.create({ path: join(dir, "off-home", "bin"), records });
  await b.disableRecords();

  const { exitCode, output } = await inTty(rec(records, "--config", b.config, tty!));

  expect(exitCode).toBe(0);
  expect(output).toMatch(/^\/dev\/pts\/\d+\r+\n/);
  expect(await b.lastSession(tty!)).toBeNull();
});

test("binrec rec uses pipes when it is not on a terminal", async () => {
  if (!tty) return;
  const records = join(dir, "pipes");
  const result = await $`${process.execPath} ${binrecBin} rec --records ${records} ${tty}`.nothrow().quiet();

  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString()).toBe("not a tty\n");
});
