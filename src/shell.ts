import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";

/**
 * Writes `value` for a double-quoted shell string: `$HOME` stands for the home
 * folder, and every other `"`, `\`, `$` and backtick is escaped.
 */
const shellPath = (value: string) => {
  const home = homedir();
  const escape = (text: string) => text.replace(/["\\$`]/g, "\\$&");
  if (value === home) return "$HOME";
  if (value.startsWith(home + sep)) return `$HOME${escape(value.slice(home.length))}`;
  return escape(value);
};

/**
 * The `export` lines that put `binDir` first in PATH. `BINREC_HOME` is exported
 * too when the bin folder is not the default `~/.binrec/bin`, so the `binrec`
 * CLI finds the same shims, records and config the shims use.
 */
export const shellLines = (binDir: string) => {
  const lines: string[] = [];
  const home = dirname(binDir);
  if (basename(binDir) === "bin" && home !== join(homedir(), ".binrec")) {
    lines.push(`export BINREC_HOME="${shellPath(home)}"`);
  }
  lines.push(`export PATH="${shellPath(binDir)}:$PATH"`);
  return lines;
};
