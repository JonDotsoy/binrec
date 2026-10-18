import { test, expect, beforeAll, afterAll } from "bun:test";
import { $ } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { binrec as lib, type Binrec } from "../index.ts";

const binrec = new URL("../bin/binrec.ts", import.meta.url).pathname;

let binrecHome: string;
let b: Binrec;
let env: Record<string, string | undefined>;

beforeAll(async () => {
  binrecHome = await mkdtemp(join(tmpdir(), "binrec-stats-"));
  b = lib.create({ path: join(binrecHome, "bin") });
  env = { ...process.env, BINREC_HOME: binrecHome, PATH: `${b.path}:${process.env.PATH}` };
});

afterAll(async () => {
  await rm(binrecHome, { recursive: true, force: true });
});

/** Replaces the absolute paths of the recorded binaries, which change between machines. */
const normalize = (text: string) => text.replace(/\/\S*\/(cat|printf)\b/g, "<path>/$1");

test("binrec stats without sessions", async () => {
  const result = await $`bun ${binrec} stats`.env(env).nothrow().quiet();
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe(`No recorded sessions in ${b.records}\n`);
});

test("chunks have a size and the end line the total of the session", async () => {
  await b.install("cat");
  await $`echo hola | cat`.env(env).quiet();

  const lines = (await b.lastSession("cat"))!.lines;
  const chunks = lines.flatMap((line) => ("size" in line ? [[line.type, line.size]] : []));
  expect(chunks).toEqual([
    ["stdin", 5],
    ["stdout", 5],
  ]);
  expect(lines.at(-1)).toMatchObject({ type: "end", total: 10 });
});

test("size counts the bytes of chunks that are not UTF-8", async () => {
  await b.install("printf");
  const format = "\\377abc";
  await $`printf ${format}`.env(env).quiet();

  const session = (await b.lastSession("printf"))!;
  expect(session.lines.find((line) => line.type === "stdout")).toMatchObject({
    size: 4,
    data: null,
  });
  expect(session.total).toBe(4);
});

test("binrec stats shows the total consumed and ranks the commands", async () => {
  await $`echo adios | cat`.env(env).quiet();

  const stats = await b.stats();
  expect(stats.sessions).toBe(3);
  expect(stats.total).toBe(10 + 4 + 12);
  expect(stats.commands.map(({ sessions, total }) => [sessions, total])).toEqual([
    [2, 22],
    [1, 4],
  ]);

  const result = await $`bun ${binrec} stats`.env(env).nothrow().quiet();
  expect(result.exitCode).toBe(0);
  expect(normalize(result.stdout.toString())).toMatchSnapshot();
});

test("every session writes its own stats file and binrec stats reads it", async () => {
  const session = (await b.lastSession("cat"))!;
  const path = join(b.records, `${session.sessionId}.stats.json`);
  expect(await Bun.file(path).json()).toEqual({
    sessionId: session.sessionId,
    command: session.command,
    total: 12,
  });

  // stats reads the small file instead of the record.
  const before = (await b.stats()).total;
  await Bun.write(path, JSON.stringify({ sessionId: session.sessionId, command: session.command, total: 1012 }));
  expect((await b.stats()).total).toBe(before + 1000);
  await Bun.write(path, JSON.stringify({ sessionId: session.sessionId, command: session.command, total: 12 }));
});

test("sessions running at the same time are all counted once", async () => {
  const fresh = lib.create({ path: join(binrecHome, "fresh", "bin") });
  await fresh.install("cat");
  const freshEnv = { ...process.env, PATH: `${fresh.path}:${process.env.PATH}` };
  await Promise.all(Array.from({ length: 16 }, () => $`echo x | cat`.env(freshEnv).quiet()));
  expect(await fresh.stats()).toEqual({
    sessions: 16,
    total: 16 * 4,
    commands: [{ command: expect.any(String), sessions: 16, total: 16 * 4 }],
  });
});

test("binrec stats reads records without a stats file, size or total from their data", async () => {
  const legacy = join(b.records, "legacy.ndjson");
  await Bun.write(
    legacy,
    [
      { type: "command", sessionId: "legacy", timestamp: "2000-01-01T00:00:00.000Z", performance: 0, command: "/bin/legacy", args: [] },
      { type: "stdout", timestamp: "2000-01-01T00:00:00.000Z", performance: 0, data: "ñandú\n" },
      { type: "stderr", timestamp: "2000-01-01T00:00:00.000Z", performance: 0, data: null, data_base64: "/w==" },
      { type: "end", timestamp: "2000-01-01T00:00:00.000Z", performance: 0, exitCode: 0 },
    ]
      .map((line) => `${JSON.stringify(line)}\n`)
      .join(""),
  );

  try {
    const stats = await b.stats();
    // The finished record gets its stats file, so the next run reads only that.
    expect(await Bun.file(join(b.records, "legacy.stats.json")).json()).toEqual({
      sessionId: "legacy",
      command: "/bin/legacy",
      total: 8 + 1,
    });
    expect(stats.commands.find(({ command }) => command === "/bin/legacy")).toEqual({
      command: "/bin/legacy",
      sessions: 1,
      total: 8 + 1,
    });
  } finally {
    await rm(legacy);
  }
  // Without its record, a stats file is not counted.
  expect((await b.stats()).commands.some(({ command }) => command === "/bin/legacy")).toBe(false);
});
