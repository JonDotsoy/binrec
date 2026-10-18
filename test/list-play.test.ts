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
  binrecHome = await mkdtemp(join(tmpdir(), "binrec-list-play-"));
  b = lib.create({ path: join(binrecHome, "bin") });
  env = { ...process.env, BINREC_HOME: binrecHome };
});

afterAll(async () => {
  await rm(binrecHome, { recursive: true, force: true });
});

/** Records a run of `command` with `binrec rec` and returns its session id. */
const record = async (...command: string[]) => {
  await $`bun ${binrec} rec ${command}`.env(env).nothrow().quiet();
  return (await b.sessions()).at(-1)!.sessionId;
};

test("binrec list without sessions", async () => {
  const result = await $`bun ${binrec} list`.env(env).nothrow().quiet();
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe(`No recorded sessions in ${b.records}\n`);
});

test("binrec list shows the id, start, exit code, size and command of every session", async () => {
  const sh = Bun.which("sh")!;
  const echo = Bun.which("echo")!;
  await $`bun ${binrec} rec ${sh} -c ${"printf hola; exit 3"}`.env(env).nothrow().quiet();
  await $`bun ${binrec} rec ${echo} ${"it's"} ok`.env(env).quiet();
  const [first, second] = await b.sessions();

  const result = await $`bun ${binrec} list`.env(env).nothrow().quiet();
  expect(result.exitCode).toBe(0);
  const lines = result.stdout.toString().trimEnd().split("\n");
  expect(lines).toHaveLength(3);
  expect(lines[0]).toMatch(/^ID +STARTED +EXIT +SIZE +COMMAND$/);
  expect(lines[1]).toMatch(
    new RegExp(`^${first!.sessionId}  \\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ +3 +4 B  ${sh} -c 'printf hola; exit 3'$`),
  );
  expect(lines[2]).toMatch(
    new RegExp(`^${second!.sessionId}  \\S+ +0 +8 B  ${echo} 'it'\\\\''s' ok$`),
  );

  const onlyEcho = await $`bun ${binrec} list echo`.env(env).quiet().text();
  expect(onlyEcho).toContain(second!.sessionId);
  expect(onlyEcho).not.toContain(first!.sessionId);
});

test("binrec play writes stdout and stderr back, bytes included, with the recorded timing", async () => {
  const script = "printf uno; sleep 0.4; printf dos >&2; printf '\\377'";
  const sessionId = await record("sh", "-c", script);

  const started = performance.now();
  const result = await $`bun ${binrec} play ${sessionId}`.env(env).nothrow().quiet();
  const elapsed = performance.now() - started;

  expect(result.exitCode).toBe(0);
  expect([...result.stdout]).toEqual([...Buffer.from("uno"), 0xff]);
  expect(result.stderr.toString()).toBe("dos");
  expect(elapsed).toBeGreaterThanOrEqual(400);
});

test("binrec play takes the start of an id and --speed 0 writes it at once", async () => {
  const sessionId = await record("sh", "-c", "printf a; sleep 1; printf b");

  const started = performance.now();
  const result = await $`bun ${binrec} play --speed 0 ${sessionId.slice(0, 8)}`
    .env(env)
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe("ab");
  expect(performance.now() - started).toBeLessThan(1000);
});

test("binrec play fails for an unknown session", async () => {
  const result = await $`bun ${binrec} play nope`.env(env).nothrow().quiet();
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toBe(`binrec: no recorded session nope in ${b.records}\n`);
});

test("binrec list --help and binrec play --help show the command's help", async () => {
  for (const flag of ["--help", "-h"]) {
    const list = await $`bun ${binrec} list ${flag}`.env(env).nothrow().quiet();
    expect(list.exitCode).toBe(0);
    expect(list.stdout.toString()).toStartWith("Usage: binrec list [<bin>]\n");

    const play = await $`bun ${binrec} play ${flag}`.env(env).nothrow().quiet();
    expect(play.exitCode).toBe(0);
    expect(play.stdout.toString()).toStartWith("Usage: binrec play [--speed <n>] <id>\n");
    expect(play.stdout.toString()).toContain("--speed <n>");
  }
});
