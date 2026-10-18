import { basename } from "node:path";
import type { RecordLine, Session, TreeSession } from "./sessions.ts";

/** A stream chunks are written to, like `process.stdout`. */
export type PlayStream = {
  write(chunk: Uint8Array, callback: (error?: Error | null) => void): unknown;
};

export type PlayOptions = {
  /** Where `stdout` chunks are written. Defaults to `process.stdout`. */
  stdout?: PlayStream;
  /** Where `stderr` chunks are written. Defaults to `process.stderr`. */
  stderr?: PlayStream;
  /**
   * How many times faster than recorded to play: `2` halves every wait, and `0`
   * or `Infinity` writes everything at once. Defaults to `1`, the recorded timing.
   */
  speed?: number;
  /**
   * Prefix every line with when it was written: the recorded `timestamp`, the
   * time since the session started and the stream (`stdout` or `stderr`). The
   * session's command line goes first and its exit code last, on `stdout`.
   */
  timestamps?: boolean;
};

/** The bytes of a chunk line, from `data` or, when it is not UTF-8, `data_base64`. */
const chunkBytes = (line: Extract<RecordLine, { data: string | null }>) =>
  line.data !== null ? Buffer.from(line.data) : Buffer.from(line.data_base64 ?? "", "base64");

const decoder = new TextDecoder();

/** Seconds since the session started, like `+1.250s`. */
const elapsed = (ms: number) => `+${(Math.max(0, ms) / 1000).toFixed(3)}s`;

/** `chunk` with every line prefixed by `prefix`, ending with a newline. */
const labelLines = (prefix: string, chunk: Uint8Array) => {
  const lines = decoder.decode(chunk).replace(/\n$/, "").split("\n");
  return Buffer.from(lines.map((line) => `${prefix}${line}\n`).join(""));
};

const showArg = (arg: string) =>
  /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;

const writeTo = (stream: PlayStream, bytes: Uint8Array) =>
  new Promise<void>((resolve, reject) =>
    stream.write(bytes, (error) => (error ? reject(error) : resolve())),
  );

/**
 * Plays a recorded session back: writes its `stdout` and `stderr` chunks again,
 * each one as long after the start as it was recorded (`performance`). `stdin`
 * chunks are not written, since what the program echoed is already in `stdout`.
 * With `timestamps`, every line also shows when and on which stream it was written.
 */
export const play = async (session: Session, options: PlayOptions = {}) => {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const speed = options.speed ?? 1;
  const realtime = speed > 0 && Number.isFinite(speed);

  const startedAt = session.lines[0]?.performance ?? 0;
  const playStart = performance.now();
  const label = (line: RecordLine, name: string) =>
    `${line.timestamp}  ${elapsed(line.performance - startedAt).padStart(9)}  ${name.padEnd(6)}  `;

  const first = session.lines[0];
  if (options.timestamps && first) {
    const command = [session.command, ...session.args].map(showArg).join(" ");
    await writeTo(stdout, Buffer.from(`${label(first, "$")}${command}\n`));
  }

  for (const line of session.lines) {
    if (line.type !== "stdout" && line.type !== "stderr" && line.type !== "end") continue;
    if (realtime) {
      const wait = (line.performance - startedAt) / speed - (performance.now() - playStart);
      if (wait > 0) await Bun.sleep(wait);
    }
    if (line.type === "end") {
      if (options.timestamps) {
        await writeTo(stdout, Buffer.from(`${label(line, "exit")}${line.exitCode}\n`));
      }
      continue;
    }
    const bytes = chunkBytes(line);
    await writeTo(
      line.type === "stdout" ? stdout : stderr,
      options.timestamps ? labelLines(label(line, line.type), bytes) : bytes,
    );
  }
};

/**
 * A copy of a nested session's output usually reaches the session it ran in
 * too (a command run from a recorded shell prints through the shell). Copies
 * are matched for this long after the nested session wrote them (ms).
 */
const COPY_WINDOW = 1000;
/** A nested session stamps its output just after writing it, so its parent may stamp the copy a bit earlier (ms). */
const COPY_SLACK = 50;

type TreeOutput = { at: number; type: "stdout" | "stderr"; text: string };

/** Every `stdout` and `stderr` chunk of `session` as text, with its time in ms since the epoch. */
const outputsOf = (session: Session): TreeOutput[] =>
  session.lines.flatMap((line) =>
    line.type === "stdout" || line.type === "stderr"
      ? [{ at: Date.parse(line.timestamp), type: line.type, text: decoder.decode(chunkBytes(line)) }]
      : [],
  );

/**
 * The output of `session` without what it only passed on from the sessions that
 * ran inside it, so each piece of output shows up once, under the session that
 * wrote it. A piece counts as a copy when it repeats, in order, what a child
 * wrote shortly before; carriage returns are ignored, since a terminal adds them.
 */
const ownOutput = (session: Session, children: Session[]): TreeOutput[] => {
  const own = outputsOf(session);
  if (children.length === 0) return own;
  const written = children
    .flatMap(outputsOf)
    .map((output) => ({ at: output.at - COPY_SLACK, text: output.text.replaceAll("\r", "") }))
    .filter((output) => output.text)
    .sort((a, b) => a.at - b.at);

  const pending: { at: number; text: string }[] = [];
  let next = 0;
  let offset = 0;
  return own.flatMap((output) => {
    while (next < written.length && written[next]!.at <= output.at) pending.push(written[next++]!);
    while (pending[0] && pending[0].at < output.at - COPY_WINDOW) {
      pending.shift();
      offset = 0;
    }
    let text = "";
    let returns = "";
    for (let index = 0; index < output.text.length; index++) {
      const char = output.text[index]!;
      const head = pending[0];
      if (char === "\r") returns += char;
      else if (head && head.text[offset] === char) {
        returns = "";
        if (++offset === head.text.length) {
          pending.shift();
          offset = 0;
        }
      } else {
        text += returns + char;
        returns = "";
      }
    }
    text += returns;
    return text ? [{ ...output, text }] : [];
  });
};

/**
 * Plays a session together with the sessions that ran inside it (`tree`, the
 * root first, as `sessionTree` returns it), interleaved by their recorded
 * `timestamp`. Every line is labeled with the session that wrote it, like
 * `bash[1a2b3c4d]`, indented by how deep it is nested; each session's command
 * line and exit code are shown as `$` and `exit` lines. Output a session only
 * passed on from one inside it is shown once, under the inner session. With
 * `timestamps`, lines also start with their timestamp and the time since the
 * root session started.
 */
export const playTree = async (tree: TreeSession[], options: PlayOptions = {}) => {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const speed = options.speed ?? 1;
  const realtime = speed > 0 && Number.isFinite(speed);
  const root = tree[0]?.session;
  if (!root) return;

  const labels = tree.map(
    ({ session, depth }) => `${"  ".repeat(depth)}${basename(session.command)}[${session.sessionId.slice(0, 8)}]`,
  );
  const width = Math.max(...labels.map((label) => label.length));

  type Entry = { at: number; timestamp: string; label: string; stream: string; text: string; error?: boolean };
  const entries: Entry[] = [];
  const timestampOf = (at: number) => new Date(at).toISOString();
  tree.forEach(({ session }, index) => {
    const label = labels[index]!.padEnd(width);
    const children = tree
      .filter((item) => item.session.parent === session.sessionId)
      .map((item) => item.session);
    const command = session.lines[0]!;
    entries.push({
      at: Date.parse(command.timestamp),
      timestamp: command.timestamp,
      label,
      stream: "$",
      text: `${[session.command, ...session.args].map(showArg).join(" ")}\n`,
    });
    for (const output of ownOutput(session, children)) {
      entries.push({
        at: output.at,
        timestamp: timestampOf(output.at),
        label,
        stream: output.type,
        text: output.text,
        error: output.type === "stderr",
      });
    }
    const end = session.lines.findLast((line) => line.type === "end");
    if (end?.type === "end") {
      entries.push({ at: Date.parse(end.timestamp), timestamp: end.timestamp, label, stream: "exit", text: `${end.exitCode}\n` });
    }
  });
  // Stable: lines written in the same millisecond keep the order of the tree.
  entries.sort((a, b) => a.at - b.at);

  const startedAt = Date.parse(root.timestamp);
  const playStart = performance.now();
  for (const entry of entries) {
    if (realtime) {
      const wait = (entry.at - startedAt) / speed - (performance.now() - playStart);
      if (wait > 0) await Bun.sleep(wait);
    }
    const time = options.timestamps
      ? `${entry.timestamp}  ${elapsed(entry.at - startedAt).padStart(9)}  `
      : "";
    const prefix = `${time}${entry.label}  ${entry.stream.padEnd(6)}  `;
    await writeTo(entry.error ? stderr : stdout, labelLines(prefix, Buffer.from(entry.text)));
  }
};
