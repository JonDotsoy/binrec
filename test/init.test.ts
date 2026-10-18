import { test, expect, beforeEach, afterEach } from "bun:test";
import { $ } from "bun";
import { mkdtemp, rm, stat } from "node:fs/promises";
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

const block = (...lines: string[]) => ["# >>> binrec >>>", ...lines, "# <<< binrec <<<", ""].join("\n");

test("binrec init adds the PATH export to ~/.bashrc and creates the bin folder", async () => {
  await Bun.write(join(home, ".bashrc"), "alias ll='ls -l'\n");

  const result = await $`bun ${cli} init`.env(env).nothrow().quiet();
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain(`Configured ${join(home, ".bashrc")}:`);
  expect(result.stdout.toString()).toContain('export PATH="$HOME/.binrec/bin:$PATH"');

  expect(await Bun.file(join(home, ".bashrc")).text()).toBe(
    `alias ll='ls -l'\n\n${block('export PATH="$HOME/.binrec/bin:$PATH"')}`,
  );
  expect((await stat(join(home, ".binrec", "bin"))).isDirectory()).toBe(true);
});

test("binrec init twice leaves a single block", async () => {
  await $`bun ${cli} init`.env(env).quiet();
  const again = await $`bun ${cli} init`.env(env).nothrow().quiet();
  expect(again.exitCode).toBe(0);
  expect(again.stdout.toString()).toContain("is already configured");
  expect(await Bun.file(join(home, ".bashrc")).text()).toBe(block('export PATH="$HOME/.binrec/bin:$PATH"'));
});

test("binrec init exports BINREC_HOME when it is not the default and updates the old block", async () => {
  const rc = join(home, ".bashrc");
  await Bun.write(rc, `before\n${block('export PATH="$HOME/.binrec/bin:$PATH"')}after\n`);

  const custom = join(home, "state");
  const result = await $`bun ${cli} init`.env({ ...env, BINREC_HOME: custom }).nothrow().quiet();
  expect(result.exitCode).toBe(0);
  expect(await Bun.file(rc).text()).toBe(
    `before\n${block('export BINREC_HOME="$HOME/state"', 'export PATH="$HOME/state/bin:$PATH"')}after\n`,
  );
});

test("binrec init --rc configures another file", async () => {
  const rc = join(home, ".zshrc");
  const result = await $`bun ${cli} init --rc ${rc}`.env(env).nothrow().quiet();
  expect(result.exitCode).toBe(0);
  expect(await Bun.file(rc).text()).toBe(block('export PATH="$HOME/.binrec/bin:$PATH"'));
  expect(await Bun.file(join(home, ".bashrc")).exists()).toBe(false);

  const missing = await $`bun ${cli} init --rc`.env(env).nothrow().quiet();
  expect(missing.exitCode).toBe(1);
});

test("a new bash that reads the block finds the shims first", async () => {
  await $`bun ${cli} init`.env(env).quiet();
  await $`bun ${cli} install date`.env(env).quiet();

  const found = await $`bash -c ${". ~/.bashrc; command -v date"}`.env(env).quiet().text();
  expect(found.trim()).toBe(join(home, ".binrec", "bin", "date"));
});

test("b.initShell writes the block for a path outside the home folder", async () => {
  const b = binrec.create({ path: join(tmpdir(), "binrec \"odd\" $dir", "shims") });
  const rc = join(home, "rc");
  try {
    const result = await b.initShell({ rc });
    expect(result).toEqual({
      rc,
      lines: [`export PATH="${b.path.replace(/["\\$`]/g, "\\$&")}:$PATH"`],
      changed: true,
    });
    const path = await $`sh -c ${`. ${rc}; printf %s "$PATH"`}`.env(env).quiet().text();
    expect(path.split(":")[0]).toBe(b.path);
    expect((await b.initShell({ rc })).changed).toBe(false);
  } finally {
    await rm(join(tmpdir(), "binrec \"odd\" $dir"), { recursive: true, force: true });
  }
});
