/// <reference path="./assets.d.ts" />
// The bundled text keeps both files inside dist/binrec.js, which ships without node_modules.
// @ts-ignore: tsc does not load JavaScript from node_modules, so it has no type for the text import
import xtermJs from "@xterm/xterm/lib/xterm.js" with { type: "text" };
import xtermCss from "@xterm/xterm/css/xterm.css" with { type: "text" };
import type { Session, TreeSession } from "../sessions.ts";
import { page, player, style } from "./player.ts";

export type PlayUiOptions = {
  /** Port to listen on, on 127.0.0.1. Defaults to `0`, a free port. */
  port?: number;
  /** Playback speed the page starts with. Defaults to `1`. */
  speed?: number;
  /**
   * Sessions that ran inside the played one, as `sessionTree` returns them after
   * the root: the page lists them and marks them on the timeline.
   */
  nested?: TreeSession[];
};

export type PlayUiServer = {
  /** Address of the page, like `http://127.0.0.1:41234/`. */
  readonly url: string;
  /** Stops the server. */
  stop(): Promise<void>;
};

/** What the page reads from `/session.json`. Times are milliseconds since the session started. */
export type UiSession = {
  sessionId: string;
  command: string;
  args: string[];
  timestamp: string;
  exitCode: number | null;
  duration: number;
  /** Terminal size at the start: the first `resize` line, or 80×24 when it was not run on a terminal. */
  cols: number;
  rows: number;
  /** True when the session ran on a terminal; otherwise a lone `\n` also returns the cursor. */
  tty: boolean;
  speed: number;
  /** Output chunks and window size changes, in order. `data` is base64. */
  events: (
    | { t: number; type: "stdout" | "stderr"; data: string }
    | { t: number; type: "resize"; cols: number; rows: number }
  )[];
  /** Sessions that ran inside this one, in tree order; `start` and `end` are ms since this session started. */
  nested: {
    sessionId: string;
    command: string;
    args: string[];
    depth: number;
    exitCode: number | null;
    start: number;
    end: number;
  }[];
};

/** Turns a session into what the page plays: output and resizes with times relative to the start. */
export const uiSession = (session: Session, speed = 1, nested: TreeSession[] = []): UiSession => {
  const start = session.lines[0]?.performance ?? 0;
  const at = (performance: number) => Math.max(0, performance - start);
  const firstResize = session.lines.find((line) => line.type === "resize");
  const events: UiSession["events"] = [];
  for (const line of session.lines) {
    if (line.type === "stdout" || line.type === "stderr") {
      const data = line.data !== null ? Buffer.from(line.data).toString("base64") : (line.data_base64 ?? "");
      events.push({ t: at(line.performance), type: line.type, data });
    } else if (line.type === "resize" && line !== firstResize) {
      events.push({ t: at(line.performance), type: "resize", cols: line.cols, rows: line.rows });
    }
  }
  const end = session.lines.findLast((line) => line.type === "end");
  return {
    sessionId: session.sessionId,
    command: session.command,
    args: session.args,
    timestamp: session.timestamp,
    exitCode: session.exitCode,
    duration: at((end ?? session.lines.at(-1))?.performance ?? start),
    cols: firstResize?.type === "resize" ? firstResize.cols : 80,
    rows: firstResize?.type === "resize" ? firstResize.rows : 24,
    tty: firstResize !== undefined,
    speed,
    events,
    nested: nested.map(({ session: inner, depth }) => {
      const since = (timestamp: string) => Math.max(0, Date.parse(timestamp) - Date.parse(session.timestamp));
      const last = inner.lines.findLast((line) => line.type === "end") ?? inner.lines.at(-1);
      return {
        sessionId: inner.sessionId,
        command: inner.command,
        args: inner.args,
        depth,
        exitCode: inner.exitCode,
        start: since(inner.timestamp),
        end: since(last?.timestamp ?? inner.timestamp),
      };
    }),
  };
};

const securityHeaders = {
  // xterm.js sets inline styles on the elements it draws.
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

/**
 * Serves a page on 127.0.0.1 that plays `session` in a terminal in the browser,
 * with a timeline to pause, rewind and fast-forward it.
 */
export const playUi = (session: Session, options: PlayUiOptions = {}): PlayUiServer => {
  const body = JSON.stringify(uiSession(session, options.speed, options.nested));
  const files: Record<string, [string, string]> = {
    "/": [page, "text/html; charset=utf-8"],
    "/player.css": [style, "text/css; charset=utf-8"],
    "/player.js": [`(${player.toString()})();\n`, "text/javascript; charset=utf-8"],
    "/xterm.css": [xtermCss, "text/css; charset=utf-8"],
    "/xterm.js": [String(xtermJs).replace(/\n\/\/# sourceMappingURL=.*$/m, ""), "text/javascript; charset=utf-8"],
    "/session.json": [body, "application/json"],
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    fetch(request) {
      // A page on another site can point its own name at 127.0.0.1 (DNS rebinding); only answer our own host.
      const host = request.headers.get("host");
      if (host !== `127.0.0.1:${server.port}` && host !== `localhost:${server.port}`) {
        return new Response("Forbidden\n", { status: 403 });
      }
      const file = request.method === "GET" ? files[new URL(request.url).pathname] : undefined;
      if (!file) return new Response("Not found\n", { status: 404 });
      return new Response(file[0], { headers: { "Content-Type": file[1], ...securityHeaders } });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/`,
    stop: () => server.stop(true),
  };
};
