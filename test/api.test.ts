import { test, expect, beforeAll, afterAll } from "bun:test";
import { $ } from "bun";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
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

test("chunks that are not valid UTF-8 are recorded as data_base64", async () => {
  const b = binrec.create({ path: join(tmp, "binary", "bin") });
  await b.install("printf");

  const env = { ...process.env, PATH: `${b.path}:${process.env.PATH}` };
  const format = "\\377abc";
  const result = await $`printf ${format}`.env(env).quiet();
  expect([...result.stdout]).toEqual([0xff, 0x61, 0x62, 0x63]);

  const session = await b.lastSession("printf");
  const stdout = session!.lines.filter((l) => l.type === "stdout");
  expect(stdout).toHaveLength(1);
  expect(stdout[0]).toMatchObject({ data: null, data_base64: "/2FiYw==" });
});

test("records can only be read by the user who recorded them", async () => {
  const records = join(tmp, "private", "records");
  const binrecBin = new URL("../bin/binrec.ts", import.meta.url).pathname;

  // A permissive umask must not widen the permissions of records.
  const result = await $`bash -c ${'umask 000 && "$@"'} _ ${process.execPath} ${binrecBin} rec --records ${records} /usr/bin/date +%Y`
    .nothrow()
    .quiet();
  expect(result.exitCode).toBe(0);

  const [recordName] = await readdir(records);
  const dirMode = (await stat(records)).mode & 0o777;
  const fileMode = (await stat(join(records, recordName!))).mode & 0o777;

  expect(dirMode.toString(8)).toBe("700");
  expect(fileMode.toString(8)).toBe("600");
});

test("b.uninstall removes only binrec shims and keeps the records", async () => {
  const b = binrec.create({ path: join(tmp, "uninstall", "bin") });
  const shimPath = await b.install("date");
  await $`date +%Y`.env({ ...process.env, PATH: `${b.path}:${process.env.PATH}` }).quiet();

  expect(await b.uninstall("date")).toBe(shimPath);
  expect(await Bun.file(shimPath).exists()).toBe(false);
  expect(await b.uninstall("date")).toBeNull();
  expect(await b.lastSession("date")).not.toBeNull();

  // A file binrec did not write is left alone.
  const other = join(b.path, "other");
  await Bun.write(other, "#!/usr/bin/env bash\necho hi\n");
  expect(await b.uninstall("other")).toBeNull();
  expect(await Bun.file(other).exists()).toBe(true);
});

test("b.uninstallAll removes every binrec shim and nothing else", async () => {
  const b = binrec.create({ path: join(tmp, "uninstall-all", "bin") });
  expect(await b.uninstallAll()).toEqual([]);

  const shims = [await b.install("date"), await b.install("true")];
  const other = join(b.path, "other");
  await Bun.write(other, "#!/usr/bin/env bash\necho hi\n");

  await mkdir(join(b.path, "folder"));

  expect(await b.uninstallAll()).toEqual(shims.sort());
  expect(await Bun.file(other).exists()).toBe(true);
});

test("b.off and b.on are aliases of disableRecords and enableRecords", async () => {
  const b = binrec.create({ path: join(tmp, "aliases", "bin") });
  await b.off();
  expect(await b.isRecording()).toBe(false);
  await b.on();
  expect(await b.isRecording()).toBe(true);
});

test("b.on(command) and b.off(command) install and uninstall", async () => {
  const b = binrec.create({ path: join(tmp, "aliases-cmd", "bin") });
  const shimPath = await b.on("date");
  expect(shimPath).toBe(join(b.path, "date"));
  expect(await b.off("date")).toBe(shimPath);
  expect(await Bun.file(join(b.path, "date")).exists()).toBe(false);
  expect(await b.isRecording()).toBe(true);
});
