import { test, expect, beforeEach, afterEach } from "bun:test";
import { $ } from "bun";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { binrec } from "../index.ts";

const cli = new URL("../bin/binrec.ts", import.meta.url).pathname;

let home: string;
let env: Record<string, string | undefined>;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "binrec-init-"));
  env = { ...process.env, HOME: home, BINREC_HOME: undefined };
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

test("binrec init creates the bin folder and only prints the PATH export", async () => {
  const result = await $`bun ${cli} init`.env(env).nothrow().quiet();
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain('  export PATH="$HOME/.binrec/bin:$PATH"\n');
  expect(result.stdout.toString()).not.toContain("BINREC_HOME");

  expect((await stat(join(home, ".binrec", "bin"))).isDirectory()).toBe(true);
  // No startup file was written or changed.
  const files = await readdir(home);
  expect(files.filter((name) => /rc$|profile$/.test(name))).toEqual([]);
});

test("binrec init leaves an existing ~/.bashrc as it was", async () => {
  await Bun.write(join(home, ".bashrc"), "alias ll='ls -l'\n");
  await $`bun ${cli} init`.env(env).quiet();
  expect(await Bun.file(join(home, ".bashrc")).text()).toBe("alias ll='ls -l'\n");
});

test("binrec init prints BINREC_HOME too when it is not the default", async () => {
  const result = await $`bun ${cli} init`.env({ ...env, BINREC_HOME: join(home, "state") }).nothrow().quiet();
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain(
    '  export BINREC_HOME="$HOME/state"\n  export PATH="$HOME/state/bin:$PATH"\n',
  );
});

test("the printed lines put the shims first in a new bash", async () => {
  const output = await $`bun ${cli} init`.env(env).quiet().text();
  await $`bun ${cli} install date`.env(env).quiet();
  const lines = output.split("\n").filter((line) => line.startsWith("  export ")).join("\n");
  await Bun.write(join(home, ".bashrc"), `${lines}\n`);

  const found = await $`bash -c ${". ~/.bashrc; command -v date"}`.env(env).quiet().text();
  expect(found.trim()).toBe(join(home, ".binrec", "bin", "date"));
});

test("b.shellLines escapes a path outside the home folder", async () => {
  const b = binrec.create({ path: join(tmpdir(), 'binrec "odd" $dir', "shims") });
  const lines = b.shellLines();
  expect(lines).toEqual([`export PATH="${b.path.replace(/["\\$`]/g, "\\$&")}:$PATH"`]);

  const path = await $`sh -c ${`${lines.join("\n")}\nprintf %s "$PATH"`}`.env(env).quiet().text();
  expect(path.split(":")[0]).toBe(b.path);
});
