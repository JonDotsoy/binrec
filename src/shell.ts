import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

/** Lines that open and close the block binrec writes in the shell startup file. */
export const BLOCK_START = "# >>> binrec >>>";
export const BLOCK_END = "# <<< binrec <<<";

export type InitShellOptions = {
  /** Shell startup file to configure. Defaults to `~/.bashrc`. */
  rc?: string;
};

export type InitShellResult = {
  /** Absolute path of the startup file that was configured. */
  rc: string;
  /** The `export` lines inside the binrec block. */
  lines: string[];
  /** `false` when the file already had exactly this block and was left as it was. */
  changed: boolean;
};

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

/** Returns `content` with the binrec block holding `lines`, replacing the block it had. */
export const withBlock = (content: string, lines: string[]) => {
  const block = [BLOCK_START, ...lines, BLOCK_END].join("\n");
  const start = content.indexOf(BLOCK_START);
  const end = start === -1 ? -1 : content.indexOf(BLOCK_END, start);
  if (start !== -1 && end !== -1) {
    return content.slice(0, start) + block + content.slice(end + BLOCK_END.length);
  }
  const separator = content === "" ? "" : content.endsWith("\n") ? "\n" : "\n\n";
  return `${content}${separator}${block}\n`;
};

/** Adds (or updates) the binrec block in the shell startup file `rc`. */
export const initShell = async (binDir: string, options: InitShellOptions = {}): Promise<InitShellResult> => {
  const rc = resolve(options.rc ?? join(homedir(), ".bashrc"));
  const file = Bun.file(rc);
  const content = (await file.exists()) ? await file.text() : "";
  const lines = shellLines(binDir);
  const next = withBlock(content, lines);
  if (next === content) return { rc, lines, changed: false };

  await mkdir(dirname(rc), { recursive: true });
  await Bun.write(rc, next);
  return { rc, lines, changed: true };
};
