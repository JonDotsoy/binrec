import { test, expect, beforeAll, afterAll } from "bun:test";
import { $ } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { binrec as lib, type Binrec } from "../index.ts";
import { uiSession } from "../src/ui/server.ts";

const binrec = new URL("../bin/binrec.ts", import.meta.url).pathname;

let binrecHome: string;
let b: Binrec;
let env: Record<string, string | undefined>;

beforeAll(async () => {
  binrecHome = await mkdtemp(join(tmpdir(), "binrec-play-ui-"));
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

/** Starts `binrec play --ui <args>` and waits for the address it prints. */
const startUi = async (...args: string[]) => {
  const child = Bun.spawn(["bun", binrec, "play", "--ui", ...args], { env, stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader();
  let output = "";
  while (!output.includes("Ctrl+C")) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`binrec play --ui exited: ${await new Response(child.stderr).text()}`);
    output += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const url = output.match(/at (http:\/\/127\.0\.0\.1:\d+\/)\n/)![1]!;
  return { child, output, url };
};

test("binrec play --ui serves the player, xterm.js and the session until Ctrl+C", async () => {
  const sessionId = await record("sh", "-c", "printf uno; sleep 0.2; printf dos >&2; printf '\\377'; exit 3");
  const { child, output, url } = await startUi(sessionId.slice(0, 8));
  try {
    expect(output).toBe(`Playing ${sessionId.slice(0, 8)} at ${url}\nOpen it in your browser. Press Ctrl+C to stop.\n`);

    const page = await fetch(url);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    const html = await page.text();
    for (const asset of ["/xterm.js", "/xterm.css", "/player.js", "/player.css"]) {
      expect(html).toContain(`"${asset}"`);
      const response = await fetch(new URL(asset, url));
      expect(response.status).toBe(200);
      expect((await response.text()).length).toBeGreaterThan(100);
    }
    expect(await fetch(new URL("/xterm.js", url)).then((r) => r.text())).toContain("Terminal");
    expect(await fetch(new URL("/player.js", url)).then((r) => r.text())).toStartWith("(function player()");

    const session = await fetch(new URL("/session.json", url)).then((r) => r.json());
    expect(session).toMatchObject({ sessionId, exitCode: 3, tty: false, cols: 80, rows: 24, speed: 1 });
    expect(session.events.map((event: { type: string; data: string }) => [event.type, event.data])).toEqual([
      ["stdout", Buffer.from("uno").toString("base64")],
      ["stderr", Buffer.from("dos").toString("base64")],
      ["stdout", Buffer.from([0xff]).toString("base64")],
    ]);
    expect(session.events[1].t).toBeGreaterThanOrEqual(200);
    expect(session.duration).toBeGreaterThanOrEqual(session.events[2].t);

    expect((await fetch(new URL("/nope", url))).status).toBe(404);
    expect((await fetch(url, { method: "POST" })).status).toBe(404);
  } finally {
    child.kill("SIGINT");
  }
  expect(await child.exited).toBe(0);
});

test("binrec play --ui only answers requests for 127.0.0.1 or localhost", async () => {
  const sessionId = await record("echo", "hola");
  const { child, url } = await startUi("--port", "0", sessionId);
  try {
    const { port } = new URL(url);
    const as = (host: string) => $`curl -s -o /dev/null -w %{http_code} -H ${`Host: ${host}`} ${url}`.text();
    expect(await as(`127.0.0.1:${port}`)).toBe("200");
    expect(await as(`localhost:${port}`)).toBe("200");
    expect(await as(`evil.example:${port}`)).toBe("403");
  } finally {
    child.kill("SIGTERM");
  }
  expect(await child.exited).toBe(0);
});

test("binrec play --ui starts the page at --speed", async () => {
  const sessionId = await record("echo", "rápido");
  const { child, url } = await startUi("--speed", "4", sessionId);
  try {
    expect((await fetch(new URL("/session.json", url)).then((r) => r.json())).speed).toBe(4);
  } finally {
    child.kill("SIGINT");
  }
  await child.exited;
});

test("binrec play --ui fails for an unknown session or a bad --port", async () => {
  const unknown = await $`bun ${binrec} play --ui nope`.env(env).nothrow().quiet();
  expect(unknown.exitCode).toBe(1);
  expect(unknown.stderr.toString()).toBe(`binrec: no recorded session nope in ${b.records}\n`);

  const badPort = await $`bun ${binrec} play --ui --port 70000 nope`.env(env).nothrow().quiet();
  expect(badPort.exitCode).toBe(1);
  expect(badPort.stderr.toString()).toBe("binrec: --port must be a port number, 0 to 65535\n");
});

test("binrec play --help shows --ui", async () => {
  const help = await $`bun ${binrec} play --help`.env(env).text();
  expect(help).toContain("binrec play --ui [--port <n>] [--speed <n>] [--tree] <id>");
  expect(help).toContain("--port <n>");
});

test("uiSession takes the terminal size from the first resize and keeps later ones as events", () => {
  const session = uiSession({
    sessionId: "s",
    command: "/usr/bin/top",
    args: [],
    parent: null,
    timestamp: "2026-10-18T00:00:00.000Z",
    exitCode: 0,
    total: 4,
    recordPath: "/tmp/s.ndjson",
    lines: [
      { type: "command", sessionId: "s", timestamp: "t", performance: 100, command: "/usr/bin/top", args: [] },
      { type: "resize", timestamp: "t", performance: 101, cols: 120, rows: 40 },
      { type: "stdin", timestamp: "t", performance: 150, data: "q", size: 1 },
      { type: "stdout", timestamp: "t", performance: 200, data: null, data_base64: "/w==", size: 1 },
      { type: "resize", timestamp: "t", performance: 300, cols: 90, rows: 20 },
      { type: "stdout", timestamp: "t", performance: 400, data: "ok\n", size: 3 },
      { type: "end", timestamp: "t", performance: 600, exitCode: 0, total: 4 },
    ],
  });
  expect(session).toMatchObject({ cols: 120, rows: 40, tty: true, duration: 500, speed: 1 });
  expect(session.events).toEqual([
    { t: 100, type: "stdout", data: "/w==" },
    { t: 200, type: "resize", cols: 90, rows: 20 },
    { t: 300, type: "stdout", data: Buffer.from("ok\n").toString("base64") },
  ]);
});
