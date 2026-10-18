import { test, expect, beforeAll, afterAll } from "bun:test";
import { $ } from "bun";
import { mkdtemp, readdir, rm } from "node:fs/promises";
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

const readRecords = async (dir: string) => {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".ndjson"));
  return Promise.all(
    files.map(async (f) =>
      (await Bun.file(join(dir, f)).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ),
  );
};

test("running date through the shim writes an ndjson record", async () => {
  const b = binrec.create({ path: join(tmp, "rec-date", "bin") });
  await b.install("date");

  const env = { ...process.env, PATH: `${b.path}:${process.env.PATH}` };
  const result = await $`date +%Y`.env(env).quiet();

  const [lines, ...others] = await readRecords(b.records);
  expect(others).toHaveLength(0);

  const first = lines![0];
  expect(first.type).toBe("command");
  expect(typeof first.sessionId).toBe("string");
  expect(typeof first.timestamp).toBe("string");
  expect(typeof first.performance).toBe("number");
  expect(first.command).toBe(Bun.which("date"));
  expect(first.args).toEqual(["+%Y"]);

  const stdout = lines!.filter((l) => l.type === "stdout").map((l) => l.data).join("");
  expect(stdout).toBe(result.stdout.toString());

  expect(lines!.at(-1)).toMatchObject({ type: "end", exitCode: 0 });
});

test("stdin and the exit code are recorded", async () => {
  const b = binrec.create({ path: join(tmp, "rec-cat", "bin") });
  await b.install("cat");
  await b.install("date");

  const env = { ...process.env, PATH: `${b.path}:${process.env.PATH}` };
  const cat = await $`echo hola | cat`.env(env).quiet();
  expect(cat.stdout.toString()).toBe("hola\n");

  const date = await $`date --binrec-bogus-flag`.env(env).nothrow().quiet();
  expect(date.exitCode).not.toBe(0);

  const sessions = await readRecords(b.records);
  const catLines = sessions.find((l) => l[0].command === Bun.which("cat"))!;
  const dateLines = sessions.find((l) => l[0].command === Bun.which("date"))!;

  expect(catLines.filter((l) => l.type === "stdin").map((l) => l.data).join("")).toBe("hola\n");
  expect(catLines.filter((l) => l.type === "stdout").map((l) => l.data).join("")).toBe("hola\n");
  expect(catLines.at(-1)).toMatchObject({ type: "end", exitCode: 0 });

  expect(dateLines.some((l) => l.type === "stderr")).toBe(true);
  expect(dateLines.at(-1)).toMatchObject({ type: "end", exitCode: date.exitCode });
});

test("sessions and lastSession return the recorded runs of a command", async () => {
  const b = binrec.create({ path: join(tmp, "sessions", "bin") });
  await b.install("date");
  await b.install("cat");

  const env = { ...process.env, PATH: `${b.path}:${process.env.PATH}` };
  await $`date +%Y`.env(env).quiet();
  await $`echo hola | cat`.env(env).quiet();
  await $`date +%m`.env(env).quiet();

  const dates = await b.sessions("date");
  expect(dates.map((s) => s.args)).toEqual([["+%Y"], ["+%m"]]);
  expect(dates.every((s) => s.command === Bun.which("date") && s.exitCode === 0)).toBe(true);

  expect(await b.sessions(Bun.which("date")!)).toHaveLength(2);

  const last = await b.lastSession("date");
  expect(last?.args).toEqual(["+%m"]);
  expect(last?.lines[0]?.type).toBe("command");
  expect(last?.lines.at(-1)).toMatchObject({ type: "end", exitCode: 0 });

  expect(await b.sessions("cat")).toHaveLength(1);
  expect(await b.sessions("ls")).toEqual([]);
  expect(await b.lastSession("ls")).toBeNull();
});

test("disableRecords turns recording off until enableRecords", async () => {
  const b = binrec.create({ path: join(tmp, "toggle", "bin") });
  await b.install("date");

  const env = { ...process.env, PATH: `${b.path}:${process.env.PATH}` };
  expect(await b.isRecording()).toBe(true);

  await b.disableRecords();
  expect(await b.isRecording()).toBe(false);
  const off = await $`date +%Y`.env(env).nothrow().quiet();
  expect(off.exitCode).toBe(0);
  expect(await b.sessions("date")).toEqual([]);

  await b.enableRecords();
  expect(await b.isRecording()).toBe(true);
  await $`date +%Y`.env(env).quiet();
  expect(await b.sessions("date")).toHaveLength(1);
});
