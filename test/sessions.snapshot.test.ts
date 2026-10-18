import { test, expect, beforeAll, afterAll } from "bun:test";
import { $ } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { binrec, type Binrec, type Session } from "../index.ts";

let tmp: string;
let b: Binrec;
let env: Record<string, string | undefined>;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "binrec-snapshot-"));
  b = binrec.create({ path: join(tmp, "bin") });
  await b.install("date");
  await b.install("cat");
  await b.install("printf");
  env = { ...process.env, PATH: `${b.path}:${process.env.PATH}` };
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** Replaces the fields that change on every run so the session can be snapshotted. */
const normalize = (session: Session | null) => {
  if (!session) return session;
  const command = `<path>/${basename(session.command)}`;
  return {
    ...session,
    sessionId: "<sessionId>",
    timestamp: "<timestamp>",
    command,
    recordPath: "<records>/<sessionId>.ndjson",
    lines: session.lines.map((line) => ({
      ...line,
      ...(line.type === "command" ? { sessionId: "<sessionId>", command } : {}),
      timestamp: "<timestamp>",
      performance: "<performance>",
    })),
  };
};

test("date session", async () => {
  await $`date -u -d @0 +%F`.env(env).quiet();
  expect(normalize(await b.lastSession("date"))).toMatchSnapshot();
});

test("cat session with stdin", async () => {
  await $`echo hola | cat`.env(env).quiet();
  expect(normalize(await b.lastSession("cat"))).toMatchSnapshot();
});

test("printf session with bytes that are not UTF-8", async () => {
  const format = "\\377abc";
  await $`printf ${format}`.env(env).quiet();
  expect(normalize(await b.lastSession("printf"))).toMatchSnapshot();
});

test("sessions of a command", async () => {
  await $`date -u -d @86400 +%F`.env(env).quiet();
  expect((await b.sessions("date")).map(normalize)).toMatchSnapshot();
});
