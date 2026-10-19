import { chmod } from "node:fs/promises";
import { resolve } from "node:path";

// Set by scripts/build.ts: in dist/binrec.js the bundle itself is the CLI.
declare const BINREC_BUNDLED: boolean | undefined;

/** Script the shims run as `bun <cliEntry> rec …`. */
const cliEntry =
  typeof BINREC_BUNDLED !== "undefined" && BINREC_BUNDLED
    ? import.meta.path
    : resolve(import.meta.dir, "../bin/binrec.ts");

/**
 * Every shim starts with these lines, so `uninstall` never removes a file binrec did not write.
 * The shell is an absolute path: `#!/usr/bin/env bash` looks bash up in PATH, so a
 * shim for `bash` would run itself forever.
 */
const SHIM_HEADER = "#!/bin/sh\nexec ";
/** Header of shims written by binrec 0.0.5 and older. */
const LEGACY_SHIM_HEADER = "#!/usr/bin/env bash\nexec ";

/** True when `content` is a shim binrec wrote. */
export const isShim = (content: string) =>
  (content.startsWith(SHIM_HEADER) || content.startsWith(LEGACY_SHIM_HEADER)) &&
  content.includes(" rec --records ");

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * Writes an executable shim at `shimPath` that runs `binrec rec` on `target`,
 * with `--config` only when `config` is given.
 */
export const writeShim = async (
  shimPath: string,
  { target, records, config }: { target: string; records: string; config?: string },
) => {
  const configFlag = config === undefined ? "" : ` --config ${shellQuote(config)}`;
  const shim = [
    `${SHIM_HEADER}${shellQuote(process.execPath)} ${shellQuote(cliEntry)} rec --records ${shellQuote(records)}${configFlag} ${shellQuote(target)} "$@"`,
    "",
  ].join("\n");
  await Bun.write(shimPath, shim);
  await chmod(shimPath, 0o755);
};
