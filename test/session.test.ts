import { test, expect, beforeAll, afterAll } from "bun:test";
import { $ } from "bun";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { binrec, Session } from "../index.ts";

let tmp: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "binrec-session-"));
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const bytes = async (stream: ReadableStream<Uint8Array>) => [...(await new Response(stream).bytes())];
const text = (stream: ReadableStream<Uint8Array>) => new Response(stream).text();
const streamOf = (value: string) => new Blob([value]).stream();

test("new Session keeps what it is given", async () => {
  const session = new Session({
    exitCode: 3,
    stdout: streamOf("out"),
    stderr: streamOf("err"),
    stdin: streamOf("in"),
    command: "/usr/bin/cat",
    args: ["-n"],
    sid: "abc",
  });

  expect(session).toBeInstanceOf(Session);
  expect(session).toMatchObject({ exitCode: 3, command: "/usr/bin/cat", args: ["-n"], sid: "abc", lines: [] });
  expect(await text(session.stdout)).toBe("out");
  expect(await text(session.stderr)).toBe("err");
  expect(await text(session.stdin)).toBe("in");
});

test("Session.fromNDJSON reads a recorded session", async () => {
  const b = binrec.create({ path: join(tmp, "cat", "bin") });
  await b.install("cat");
  await $`echo hola | cat`.env({ ...process.env, PATH: `${b.path}:${process.env.PATH}` }).quiet();

  const [record] = (await readdir(b.records)).filter((file) => file.endsWith(".ndjson"));
  const session = await Session.fromNDJSON(Bun.file(join(b.records, record!)).stream());

  expect(session).toBeInstanceOf(Session);
  expect(session.sid).toBe(record!.replace(/\.ndjson$/, ""));
  expect(session.command).toBe(Bun.which("cat")!);
  expect(session.args).toEqual([]);
  expect(session.exitCode).toBe(0);
  expect(await text(session.stdin)).toBe("hola\n");
  expect(await text(session.stdout)).toBe("hola\n");
  expect(await text(session.stderr)).toBe("");
  expect(session.lines[0]?.type).toBe("command");
});

test("Session streams keep bytes that are not UTF-8", async () => {
  const b = binrec.create({ path: join(tmp, "printf", "bin") });
  await b.install("printf");
  const format = "\\377abc";
  await $`printf ${format}`.env({ ...process.env, PATH: `${b.path}:${process.env.PATH}` }).quiet();

  const session = await b.lastSession("printf");
  expect(session).toBeInstanceOf(Session);
  expect(await bytes(session!.stdout)).toEqual([0xff, 0x61, 0x62, 0x63]);
});

test("Session.fromNDJSON gives null as the exit code of a session that has not ended", async () => {
  const record = JSON.stringify({
    type: "command",
    sessionId: "s1",
    timestamp: "2026-10-18T00:00:00.000Z",
    performance: 1,
    command: "/bin/sleep",
    args: ["9"],
  });
  const session = await Session.fromNDJSON(streamOf(`${record}\n`));

  expect(session.exitCode).toBeNull();
  expect(session.sid).toBe("s1");
  expect(await text(session.stdout)).toBe("");
});

test("Session.fromNDJSON rejects a record without a command line", async () => {
  await expect(Session.fromNDJSON(streamOf(""))).rejects.toThrow("no command line");
  await expect(Session.fromNDJSON(streamOf(`${JSON.stringify({ type: "end", exitCode: 0 })}\n`))).rejects.toThrow();
});
