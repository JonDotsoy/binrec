import { test, expect, beforeAll, afterAll } from "bun:test";
import { $ } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
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

test("build writes dist/binrec.js, dist/package.json, README.md, LICENSE and SECURITY.md", async () => {
  const pkg = await Bun.file(join(dist, "package.json")).json();
  expect(pkg).toMatchObject({
    name: "@jondotsoy/binrec",
    license: "MIT",
    author: { name: "Jonathan Delgado", email: "hi@jon.soy", url: "https://jon.soy" },
    bugs: { url: "https://github.com/JonDotsoy/binrec/issues", email: "hi@jon.soy" },
    repository: { type: "git", url: "git+https://github.com/JonDotsoy/binrec.git" },
    version: (await Bun.file(join(root, "package.json")).json()).version,
    publishConfig: { registry: "https://registry.npmjs.org/", access: "public" },
    exports: { ".": "./binrec.js" },
    bin: { binrec: "binrec.js" },
  });
  expect(pkg.private).toBeUndefined();
  expect((await Bun.file(cli).text()).startsWith("#!/usr/bin/env bun\n")).toBe(true);
  for (const file of ["README.md", "LICENSE", "SECURITY.md"]) {
    expect(await Bun.file(join(dist, file)).text()).toBe(await Bun.file(join(root, file)).text());
  }
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

test("dist/binrec.js --version prints the built version", async () => {
  const { version } = await Bun.file(join(root, "package.json")).json();
  expect(await $`${cli} --version`.text()).toBe(`${version}\n`);
});
