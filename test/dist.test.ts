import { test, expect, beforeAll, afterAll } from "bun:test";
import { $ } from "bun";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const dist = join(root, "dist");
const cli = join(dist, "binrec.js");

let binrecHome: string;

beforeAll(async () => {
  await $`bun run build`.cwd(root).quiet();
  binrecHome = await mkdtemp(join(tmpdir(), "binrec-dist-"));
});

afterAll(async () => {
  await rm(binrecHome, { recursive: true, force: true });
});

test("build writes dist/binrec.js, dist/binrec.d.ts, dist/package.json, README.md, LICENSE, SECURITY.md and FONT-LICENSE.txt", async () => {
  const pkg = await Bun.file(join(dist, "package.json")).json();
  expect(pkg).toMatchObject({
    name: "@jondotsoy/binrec",
    license: "MIT",
    author: { name: "Jonathan Delgado", email: "hi@jon.soy", url: "https://jon.soy" },
    bugs: { url: "https://github.com/JonDotsoy/binrec/issues", email: "hi@jon.soy" },
    repository: { type: "git", url: "git+https://github.com/JonDotsoy/binrec.git" },
    version: (await Bun.file(join(root, "package.json")).json()).version,
    publishConfig: { registry: "https://registry.npmjs.org/", access: "public" },
    types: "./binrec.d.ts",
    exports: { ".": { types: "./binrec.d.ts", default: "./binrec.js" } },
    bin: { binrec: "binrec.js" },
  });
  expect(pkg.private).toBeUndefined();
  expect(await Bun.file(join(dist, "binrec.d.ts")).exists()).toBe(true);
  expect((await Bun.file(cli).text()).startsWith("#!/usr/bin/env bun\n")).toBe(true);
  for (const file of ["README.md", "LICENSE", "SECURITY.md"]) {
    expect(await Bun.file(join(dist, file)).text()).toBe(await Bun.file(join(root, file)).text());
  }
  expect(await Bun.file(join(dist, "FONT-LICENSE.txt")).text()).toContain("SIL OPEN FONT LICENSE Version 1.1");
});

test("dist/binrec.js works as the binrec bin", async () => {
  const env = { ...process.env, BINREC_HOME: binrecHome };
  const binDir = join(binrecHome, "bin");

  expect((await $`${cli} install date`.env(env).nothrow().quiet()).exitCode).toBe(0);
  expect(await Bun.file(join(binDir, "date")).text()).toContain(`'${cli}' rec`);

  const result = await $`date +%Y`.env({ ...env, PATH: `${binDir}:${process.env.PATH}` }).quiet();
  const expected = await $`date +%Y`.quiet().text();
  expect(result.stdout.toString()).toBe(expected);
});

test("dist/binrec.js works as the library", async () => {
  const { binrec } = await import(cli);
  const b = binrec.create({ path: join(binrecHome, "bin") });

  const last = await b.lastSession("date");
  expect(last?.args).toEqual(["+%Y"]);
  expect(last?.exitCode).toBe(0);
});

test("dist/binrec.js play --ui serves the player with xterm.js from the bundle", async () => {
  const { binrec } = await import(cli);
  const b = binrec.create({ path: join(binrecHome, "bin") });
  const last = await b.lastSession("date");
  const server = await b.playUi(last.sessionId);
  try {
    expect(await fetch(new URL("/xterm.js", server.url)).then((r) => r.text())).toContain("Terminal");
    expect(await fetch(new URL("/player.js", server.url)).then((r) => r.text())).toStartWith("(function player()");
    expect((await fetch(new URL("/sessions.json", server.url)).then((r) => r.json())).selected).toBe(last.sessionId);
  } finally {
    await server.stop();
  }
});

test.skipIf(!Bun.which("ffmpeg"))("dist/binrec.js export draws a video with the font in the bundle", async () => {
  const { binrec } = await import(cli);
  const b = binrec.create({ path: join(binrecHome, "bin") });
  const last = await b.lastSession("date");
  const output = join(binrecHome, "date.gif");
  const result = await b.exportVideo(last.sessionId, output);
  expect(result).toMatchObject({ output, format: "gif", width: 820, height: 524 });
  expect((await Bun.file(output).bytes()).subarray(0, 6)).toEqual(new TextEncoder().encode("GIF89a"));
});

test("dist/binrec.js --version prints the built version", async () => {
  const { version } = await Bun.file(join(root, "package.json")).json();
  expect(await $`${cli} --version`.text()).toBe(`${version}\n`);
});

test("dist/binrec.d.ts types the library without the sources or @types/bun", async () => {
  const types = await Bun.file(join(dist, "binrec.d.ts")).text();
  expect(types).not.toContain("./src/");
  expect(types).not.toMatch(/\bimport\b|reference types/);

  // A consumer project that installs dist as @jondotsoy/binrec.
  const consumer = await mkdtemp(join(tmpdir(), "binrec-types-"));
  try {
    await mkdir(join(consumer, "node_modules", "@jondotsoy"), { recursive: true });
    await symlink(dist, join(consumer, "node_modules", "@jondotsoy", "binrec"));
    await Bun.write(
      join(consumer, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          lib: ["ES2022"],
          module: "ESNext",
          moduleResolution: "bundler",
          strict: true,
          types: [],
          noEmit: true,
        },
        files: ["consumer.ts"],
      }),
    );
    await Bun.write(
      join(consumer, "consumer.ts"),
      [
        `import { binrec, rec, defaultPath, type Binrec, type Session, type Stats, type RecResult } from "@jondotsoy/binrec";`,
        `const b: Binrec = binrec.create({ path: defaultPath() });`,
        `export const last: Promise<Session | null> = b.lastSession("date");`,
        `export const stats: Promise<Stats> = b.stats();`,
        `export const result: Promise<RecResult> = rec("/bin/date", [], { records: false });`,
        `export const same: typeof rec = binrec.rec;`,
        `// @ts-expect-error install needs a command`,
        `b.install();`,
        `// @ts-expect-error only what index.ts exports is public`,
        `import { create } from "@jondotsoy/binrec";`,
        "",
      ].join("\n"),
    );
    const result = await $`${join(root, "node_modules", ".bin", "tsc")} -p ${consumer}`.nothrow().quiet();
    expect(result.stdout.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  } finally {
    await rm(consumer, { recursive: true, force: true });
  }
});
