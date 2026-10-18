import { test, expect } from "bun:test";
import { $ } from "bun";

const binrec = new URL("../bin/binrec.ts", import.meta.url).pathname;

test("binrec exits with code 0", async () => {
  const result = await $`echo "date $(date +%Y-%m-%dT%H:%M:%S)" | bun ${binrec}`
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(0);
});
