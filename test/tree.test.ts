import { test, expect, beforeAll, afterAll } from "bun:test";
import { $ } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { binrec as lib, playTree, type Binrec, type Session } from "../index.ts";
import { uiSession } from "../src/ui/server.ts";

const binrec = new URL("../bin/binrec.ts", import.meta.url).pathname;

let binrecHome: string;
let b: Binrec;
let env: Record<string, string | undefined>;

beforeAll(async () => {
  binrecHome = await mkdtemp(join(tmpdir(), "binrec-tree-"));
  b = lib.create({ path: join(binrecHome, "bin") });
  const { BINREC_SESSION: _, ...rest } = process.env;
  env = { ...rest, BINREC_HOME: binrecHome };
});

afterAll(async () => {
  await rm(binrecHome, { recursive: true, force: true });
});

const rec = `bun ${binrec} rec`;

/**
 * Records `sh` running a nested `sh`, which runs a recorded `printf`, and
 * returns the three sessions, outermost first.
 */
const recordNested = async () => {
  const before = new Set((await b.sessions()).map((session) => session.sessionId));
  const inner = `echo dentro; ${rec} printf 'hoja\\n'; echo err >&2`;
  await $`bun ${binrec} rec sh -c ${`${rec} sh -c "${inner}"; echo fin`}`.env(env).quiet();
  const found = (await b.sessions()).filter((session) => !before.has(session.sessionId));
  const outer = found.find((session) => session.parent === null)!;
  const middle = found.find((session) => session.parent === outer.sessionId)!;
  const leaf = found.find((session) => session.parent === middle.sessionId)!;
  return { outer, middle, leaf };
};

test("a session run inside a recorded one saves its id as parent", async () => {
  const { outer, middle, leaf } = await recordNested();
  expect(outer.parent).toBeNull();
  expect(outer.lines[0]).not.toHaveProperty("parent");
  expect(middle.lines[0]).toMatchObject({ type: "command", parent: outer.sessionId });
  expect(leaf.args).toEqual(["hoja\\n"]);

  const tree = await b.sessionTree(outer.sessionId.slice(0, 8));
  expect(tree.map(({ session, depth }) => [session.sessionId, depth])).toEqual([
    [outer.sessionId, 0],
    [middle.sessionId, 1],
    [leaf.sessionId, 2],
  ]);
  expect((await b.sessionTree(middle.sessionId)).map(({ depth }) => depth)).toEqual([0, 1]);
  expect(await b.sessionTree("nope")).toEqual([]);
});

test("binrec list shows nested sessions right after their parent, indented", async () => {
  const { outer, middle, leaf } = await recordNested();
  const lines = (await $`bun ${binrec} list`.env(env).quiet().text()).trimEnd().split("\n");
  const at = (id: string) => lines.findIndex((line) => line.startsWith(id));
  expect(at(middle.sessionId)).toBe(at(outer.sessionId) + 1);
  expect(at(leaf.sessionId)).toBe(at(outer.sessionId) + 2);
  expect(lines[at(outer.sessionId)]).toMatch(/ B  \/\S*sh -c /);
  expect(lines[at(middle.sessionId)]).toMatch(/ B  └─ \/\S*sh -c /);
  expect(lines[at(leaf.sessionId)]).toMatch(/ B     └─ \/\S*printf 'hoja\\n'$/);

  // Filtered by command, a nested session without its parent is listed at the top level.
  const printf = await $`bun ${binrec} list printf`.env(env).quiet().text();
  expect(printf).toMatch(new RegExp(`${leaf.sessionId} .* B  /\\S*printf`));
});

test("binrec play --tree interleaves the nested sessions, each line labeled, without repeating output", async () => {
  const { outer, middle, leaf } = await recordNested();
  const label = (session: Session, depth: number) =>
    `${"  ".repeat(depth)}${session.command.split("/").at(-1)}[${session.sessionId.slice(0, 8)}]`;
  const width = label(leaf, 2).length;
  const row = (session: Session, depth: number, stream: string, text: string) =>
    `${label(session, depth).padEnd(width)}  ${stream.padEnd(6)}  ${text}`;

  for (const flag of ["--tree", "-T"]) {
    const result = await $`bun ${binrec} play -n ${flag} ${outer.sessionId}`.env(env).nothrow().quiet();
    expect(result.exitCode).toBe(0);
    const out = result.stdout.toString().trimEnd().split("\n");
    expect(out[0]).toStartWith(row(outer, 0, "$", "/"));
    expect(out[1]).toStartWith(row(middle, 1, "$", "/"));
    expect(out.slice(2)).toEqual([
      row(middle, 1, "stdout", "dentro"),
      expect.stringMatching(new RegExp(`^${row(leaf, 2, "$", "").replace(/[[\]$]/g, "\\$&")}/\\S*printf 'hoja\\\\n'$`)),
      row(leaf, 2, "stdout", "hoja"),
      row(leaf, 2, "exit", "0"),
      row(middle, 1, "exit", "0"),
      row(outer, 0, "stdout", "fin"),
      row(outer, 0, "exit", "0"),
    ]);
    expect(result.stderr.toString()).toBe(`${row(middle, 1, "stderr", "err")}\n`);
  }

  const timestamps = await $`bun ${binrec} play -n -t -T ${outer.sessionId}`.env(env).quiet().text();
  expect(timestamps.split("\n")[0]).toMatch(/^\d{4}-\d\d-\d\dT\S+Z +\+0\.000s  sh\[/);
});

test("binrec play --tree waits like the recorded run", async () => {
  await $`bun ${binrec} rec sh -c ${`sleep 0.4; ${rec} echo tarde`}`.env(env).quiet();
  const outer = (await b.sessions()).findLast((session) => session.parent === null && session.args.length === 2)!;
  const started = performance.now();
  const out = await $`bun ${binrec} play --tree ${outer.sessionId}`.env(env).quiet().text();
  expect(performance.now() - started).toBeGreaterThanOrEqual(400);
  expect(out).toMatch(/ {2}echo\[\w+\] +stdout  tarde\n/);
  expect(out).not.toMatch(/^sh\[\w+\] +stdout/m);
});

test("playTree keeps a parent's own output that only looks like its child's", async () => {
  const at = (ms: number) => new Date(Date.UTC(2026, 9, 18) + ms).toISOString();
  const session = (sessionId: string, parent: string | null, lines: [number, string, string][]): Session => ({
    sessionId,
    command: `/bin/${sessionId}`,
    args: [],
    parent,
    timestamp: at(0),
    exitCode: 0,
    total: 0,
    recordPath: "",
    lines: [
      { type: "command", sessionId, timestamp: at(0), performance: 0, command: `/bin/${sessionId}`, args: [] },
      ...lines.map(([ms, type, data]) => ({ type: type as "stdout", timestamp: at(ms), performance: ms, data })),
      { type: "end", timestamp: at(5000), performance: 5000, exitCode: 0 },
    ],
  });
  // The shell echoes the child's "hola" right after it (with a carriage return, like a terminal),
  // and much later prints "hola" again on its own.
  const shell = session("shell", null, [[10, "stdout", "$ "], [21, "stdout", "hola\r\n"], [3000, "stdout", "hola\n"]]);
  const child = session("child", "shell", [[20, "stdout", "hola\n"]]);

  const chunks: string[] = [];
  const stream = { write: (chunk: Uint8Array, done: () => void) => (chunks.push(Buffer.from(chunk).toString()), done()) };
  await playTree([{ session: shell, depth: 0 }, { session: child, depth: 1 }], { speed: 0, stdout: stream, stderr: stream });
  expect(chunks.join("").split("\n").filter((line) => line.includes("stdout"))).toEqual([
    "shell[shell]    stdout  $ ",
    "  child[child]  stdout  hola",
    "shell[shell]    stdout  hola",
  ]);
});

test("binrec play --ui --tree lists the nested sessions in session.json", async () => {
  const { outer, middle, leaf } = await recordNested();
  const tree = await b.sessionTree(outer.sessionId);
  const ui = uiSession(outer, 1, tree.slice(1));
  expect(ui.nested.map(({ sessionId, depth, exitCode }) => [sessionId, depth, exitCode])).toEqual([
    [middle.sessionId, 1, 0],
    [leaf.sessionId, 2, 0],
  ]);
  expect(ui.nested[1]!.start).toBeGreaterThanOrEqual(ui.nested[0]!.start);
  expect(ui.nested[1]!.end).toBeLessThanOrEqual(ui.nested[0]!.end);
  expect(uiSession(outer).nested).toEqual([]);

  const server = await b.playUi(outer.sessionId, { tree: true });
  try {
    const session = await fetch(new URL("/session.json", server.url)).then((r) => r.json());
    expect(session.nested).toHaveLength(2);
  } finally {
    await server.stop();
  }
});

test("binrec play --help shows --tree", async () => {
  const help = await $`bun ${binrec} play --help`.env(env).text();
  expect(help).toContain("binrec play [--timestamps] [--no-wait | --speed <n>] [--tree] <id>");
  expect(help).toContain("--tree, -T");
});
