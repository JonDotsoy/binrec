/// <reference path="./assets.d.ts" />
// The bundled text keeps both files inside dist/binrec.js, which ships without node_modules.
// @ts-ignore: tsc does not load JavaScript from node_modules, so it has no type for the text import
import xtermJs from "@xterm/xterm/lib/xterm.js" with { type: "text" };
import xtermCss from "@xterm/xterm/css/xterm.css" with { type: "text" };
import { asTrees, type Session, type TreeSession } from "../sessions.ts";
import { page, player, style } from "./player.ts";

export type PlayUiOptions = {
  /** Port to listen on, on 127.0.0.1. Defaults to `0`, a free port. */
  port?: number;
  /** Playback speed the page starts with. Defaults to `1`. */
  speed?: number;
  /**
   * Id of the session the page opens with. Without it, a page serving a
   * `PlayUiSource` opens with the panel of recorded sessions, and one serving a
   * session or a tree opens with its first session.
   */
  selected?: string;
};

/** Where a page that lists every recorded session reads them from, like a records folder. */
export type PlayUiSource = {
  /** Every recorded session, for the panel. */
  sessions(): Promise<Session[]>;
  /** The tree session `id` belongs to, from its outermost session (`sessionTree` with `fromRoot`); empty when there is none. */
  tree(id: string): Promise<TreeSession[]>;
};

export type PlayUiServer = {
  /** Address of the page, like `http://127.0.0.1:41234/`. */
  readonly url: string;
  /** Stops the server. */
  stop(): Promise<void>;
};

/** One session of what the page plays. Times are milliseconds since the session started. */
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
  /** Id of the session this one ran inside, or `null`. */
  parent: string | null;
  /** How deep it is in the tree the page plays: `0` for the root. */
  depth: number;
  /** When it started, in ms since the root of the tree started. */
  offset: number;
};

/** Turns a session into what the page plays: output and resizes with times relative to the start. */
export const uiSession = (session: Session, speed = 1, depth = 0, offset = 0): UiSession => {
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
    parent: session.parent,
    depth,
    offset,
  };
};

/** What the page reads from `/tree.json?id=<id>`: every session of the tree, the root first. */
export type UiTree = {
  speed: number;
  /** Index in `sessions` of the session the page shows first. */
  selected: number;
  sessions: UiSession[];
};

/** Turns a tree (`sessionTree`) into what the page plays; every `offset` is ms since the root started. */
export const uiTree = (tree: TreeSession[], speed = 1, selected?: string): UiTree => {
  const start = Date.parse(tree[0]?.session.timestamp ?? "");
  return {
    speed,
    selected: selected ? Math.max(0, tree.findIndex(({ session }) => session.sessionId.startsWith(selected))) : 0,
    sessions: tree.map(({ session, depth }) =>
      uiSession(session, speed, depth, Math.max(0, Date.parse(session.timestamp) - start) || 0),
    ),
  };
};

/** What the page reads from `/sessions.json`: every recorded session, as trees, for the panel. */
export type UiIndex = {
  speed: number;
  /** Id of the session to open, or `null` to open with the panel. */
  selected: string | null;
  sessions: {
    sessionId: string;
    command: string;
    args: string[];
    timestamp: string;
    exitCode: number | null;
    total: number;
    parent: string | null;
    /** Depth in its tree: `0` for a session that did not run inside a listed one. */
    depth: number;
  }[];
};

export const uiIndex = (found: Session[], speed = 1, selected: string | null = null): UiIndex => ({
  speed,
  selected,
  sessions: asTrees(found).map(({ session, depth }) => ({
    sessionId: session.sessionId,
    command: session.command,
    args: session.args,
    timestamp: session.timestamp,
    exitCode: session.exitCode,
    total: session.total,
    parent: session.parent,
    depth,
  })),
});

const json = (body: unknown) => [JSON.stringify(body), "application/json"] as const;

const securityHeaders = {
  // xterm.js sets inline styles on the elements it draws.
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

/**
 * Serves a page on 127.0.0.1 that plays recorded sessions in a terminal in the
 * browser, with a timeline to pause, rewind and fast-forward them. The page
 * shows every session of the run it plays (the tree from its outermost
 * session): when each one started and ended, which one ran inside which, and
 * lets you pick the one the terminal shows. A panel lists every session it can
 * play, to open another one.
 *
 * `source` is a `Session`, a tree (`sessionTree`), or a `PlayUiSource` that
 * reads them on every request, like the records folder of `binrec play --ui`.
 */
export const playUi = (
  source: Session | TreeSession[] | PlayUiSource,
  options: PlayUiOptions = {},
): PlayUiServer => {
  const speed = options.speed ?? 1;
  let reader: PlayUiSource;
  let first: string | null = null;
  if ("tree" in source && typeof source.tree === "function") {
    reader = source;
  } else {
    const tree = Array.isArray(source) ? source : [{ session: source as Session, depth: 0 }];
    first = tree[0]?.session.sessionId ?? null;
    reader = {
      sessions: async () => tree.map(({ session }) => session),
      tree: async (id) => (tree.some(({ session }) => session.sessionId === id) ? tree : []),
    };
  }
  const selected = options.selected ?? first;

  const files: Record<string, readonly [string, string]> = {
    "/": [page, "text/html; charset=utf-8"],
    "/player.css": [style, "text/css; charset=utf-8"],
    "/player.js": [`(${player.toString()})();\n`, "text/javascript; charset=utf-8"],
    "/xterm.css": [xtermCss, "text/css; charset=utf-8"],
    "/xterm.js": [String(xtermJs).replace(/\n\/\/# sourceMappingURL=.*$/m, ""), "text/javascript; charset=utf-8"],
  };

  const respond = async (url: URL): Promise<readonly [string, string] | undefined> => {
    if (url.pathname === "/sessions.json") return json(uiIndex(await reader.sessions(), speed, selected));
    if (url.pathname === "/tree.json") {
      const id = url.searchParams.get("id") ?? "";
      const tree = await reader.tree(id).catch(() => []); // an unreadable or ambiguous id
      return tree.length > 0 ? json(uiTree(tree, speed, id)) : undefined;
    }
    return files[url.pathname];
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    async fetch(request) {
      // A page on another site can point its own name at 127.0.0.1 (DNS rebinding); only answer our own host.
      const host = request.headers.get("host");
      if (host !== `127.0.0.1:${server.port}` && host !== `localhost:${server.port}`) {
        return new Response("Forbidden\n", { status: 403 });
      }
      const file = request.method === "GET" ? await respond(new URL(request.url)) : undefined;
      if (!file) return new Response("Not found\n", { status: 404 });
      return new Response(file[0], { headers: { "Content-Type": file[1], ...securityHeaders } });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/`,
    stop: () => server.stop(true),
  };
};
