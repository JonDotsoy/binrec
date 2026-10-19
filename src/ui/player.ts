/// <reference lib="dom" />
// The page `binrec play --ui` serves. `player` runs in the browser: the server
// sends `player.toString()`, so it must not use anything from outside its body.

export const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>binrec play</title>
<link rel="stylesheet" href="/xterm.css">
<link rel="stylesheet" href="/player.css">
</head>
<body>
<header>
  <button id="toggle" title="Recorded sessions" aria-label="Recorded sessions" aria-controls="panel">&#x2630;</button>
  <span class="brand">binrec</span>
  <select id="session" hidden aria-label="Session to play"></select>
  <code id="command"></code>
  <span id="meta"></span>
</header>
<div id="body">
  <aside id="panel" hidden>
    <input id="filter" type="search" placeholder="Filter sessions" aria-label="Filter sessions">
    <ol id="list" aria-label="Recorded sessions"></ol>
  </aside>
  <main>
    <p id="empty" hidden>Pick a recorded session to play it.</p>
    <div id="screen"><div id="terminal"></div></div>
  </main>
</div>
<footer>
  <div id="processes" hidden aria-label="Processes of this run: when each one started and ended"></div>
  <div id="timeline" role="slider" tabindex="0" aria-label="Timeline" aria-valuemin="0">
    <canvas></canvas>
    <div id="tooltip" hidden></div>
  </div>
  <div class="controls">
    <button id="prev" title="Previous change ( , )" aria-label="Previous change">&#x23EE;</button>
    <button id="play" title="Play / pause (Space)" aria-label="Play">&#x25B6;</button>
    <button id="next" title="Next change ( . )" aria-label="Next change">&#x23ED;</button>
    <span id="time">0:00.000 / 0:00.000</span>
    <span class="spacer"></span>
    <label><input type="checkbox" id="skip"> Skip pauses</label>
    <label>Speed <select id="speed">
      <option value="0.25">0.25×</option><option value="0.5">0.5×</option><option value="1">1×</option>
      <option value="2">2×</option><option value="4">4×</option><option value="8">8×</option><option value="16">16×</option>
    </select></label>
  </div>
  <p class="hint">Space play/pause · ←/→ 1 s (Shift 10 s) · , / . previous/next change · Home/End</p>
</footer>
<script src="/xterm.js"></script>
<script src="/player.js"></script>
</body>
</html>
`;

export const style = `
:root {
  color-scheme: dark;
  --bg: #0d1117; --panel: #161b22; --border: #30363d; --text: #e6edf3; --muted: #8b949e;
  --accent: #58a6ff; --change: #3fb950; --stderr: #f85149; --played: rgba(88, 166, 255, 0.18);
  --process: #d2a8ff;
}
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body {
  display: flex; flex-direction: column; background: var(--bg); color: var(--text);
  font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
}
button { font: inherit; }
header {
  display: flex; align-items: center; gap: 12px; padding: 10px 16px;
  border-bottom: 1px solid var(--border); background: var(--panel); min-width: 0;
}
#toggle {
  width: 32px; height: 28px; border-radius: 6px; border: 1px solid var(--border);
  background: var(--bg); color: var(--text); cursor: pointer;
}
#toggle[aria-expanded="true"] { border-color: var(--accent); color: var(--accent); }
.brand { font-weight: 600; color: var(--accent); }
#session { max-width: 240px; }
#command { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#meta { color: var(--muted); white-space: nowrap; font-size: 12px; }
.exit { padding: 1px 6px; border-radius: 10px; border: 1px solid var(--border); margin-left: 6px; font-size: 11px; }
.exit.ok { color: var(--change); } .exit.fail { color: var(--stderr); }
#body { flex: 1; min-height: 0; display: flex; }
#panel {
  width: 340px; max-width: 45vw; display: flex; flex-direction: column; gap: 8px; padding: 10px;
  border-right: 1px solid var(--border); background: var(--panel); min-height: 0;
}
#panel[hidden] { display: none; }
#filter {
  width: 100%; padding: 5px 8px; border-radius: 6px; border: 1px solid var(--border);
  background: var(--bg); color: var(--text);
}
#list {
  list-style: none; margin: 0; padding: 0; overflow: auto; flex: 1;
  font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
#list button {
  display: block; width: 100%; padding: 4px 6px; border: 0; border-radius: 4px; background: none;
  color: var(--text); text-align: left; cursor: pointer; font: inherit;
}
#list button:hover { background: var(--bg); }
#list button.active { background: rgba(88, 166, 255, 0.16); }
#list .row { display: flex; gap: 6px; align-items: baseline; white-space: nowrap; }
#list .line { overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 1; }
#list .sub { display: block; color: var(--muted); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tree { color: var(--muted); white-space: pre; }
.name { color: var(--process); }
main { flex: 1; min-width: 0; min-height: 0; overflow: auto; display: flex; padding: 16px; }
#empty { margin: auto; color: var(--muted); }
#screen {
  margin: auto; padding: 10px; background: #000; border: 1px solid var(--border);
  border-radius: 8px; box-shadow: 0 8px 30px rgba(0, 0, 0, 0.4);
}
#screen[hidden] { display: none; }
footer { border-top: 1px solid var(--border); background: var(--panel); padding: 10px 16px 6px; }
#processes {
  max-height: 150px; overflow: auto; margin-bottom: 8px;
  font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
#processes button {
  display: grid; grid-template-columns: minmax(160px, 30%) 1fr; gap: 8px; align-items: center;
  width: 100%; padding: 1px 4px; border: 0; border-radius: 4px; background: none; color: var(--muted);
  text-align: left; cursor: pointer; font: inherit;
}
#processes button:hover { background: var(--bg); }
#processes button.selected { color: var(--text); background: rgba(88, 166, 255, 0.12); }
#processes .label { display: flex; align-items: baseline; min-width: 0; white-space: nowrap; overflow: hidden; }
#processes .track { position: relative; height: 12px; }
#processes .bar {
  position: absolute; top: 2px; height: 8px; min-width: 2px; border-radius: 3px;
  background: var(--process); opacity: 0.55;
}
#processes .bar.fail { background: var(--stderr); }
#processes button.selected .bar { opacity: 1; outline: 1px solid var(--text); }
#processes .now { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--text); }
#timeline { position: relative; height: 36px; cursor: pointer; outline: none; touch-action: none; }
/* Lined up with the bars of the processes above it, so both share one time axis. */
footer.processes #timeline { margin: 0 4px 0 calc(max(160px, 0.3 * (100% - 8px)) + 12px); }
#timeline:focus-visible { box-shadow: 0 0 0 2px var(--accent); border-radius: 4px; }
.xterm-viewport { scrollbar-width: thin; scrollbar-color: var(--border) transparent; }
#timeline canvas { width: 100%; height: 100%; display: block; }
#tooltip {
  position: absolute; bottom: 100%; transform: translateX(-50%); margin-bottom: 4px; padding: 2px 6px;
  background: var(--bg); border: 1px solid var(--border); border-radius: 4px; font-size: 12px;
  white-space: nowrap; pointer-events: none; font-variant-numeric: tabular-nums;
}
.controls { display: flex; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
.controls button {
  width: 36px; height: 32px; border-radius: 6px; border: 1px solid var(--border);
  background: var(--bg); color: var(--text); font-size: 15px; cursor: pointer;
}
.controls button:hover { border-color: var(--accent); }
#play { width: 44px; }
#time { font-variant-numeric: tabular-nums; color: var(--muted); margin-left: 4px; }
.spacer { flex: 1; }
label { color: var(--muted); font-size: 13px; display: flex; align-items: center; gap: 6px; }
select { background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 3px 4px; }
.hint { margin: 6px 0 0; color: var(--muted); font-size: 11px; }
@media (max-width: 700px) {
  #panel { position: absolute; z-index: 2; top: 49px; bottom: 0; left: 0; max-width: 90vw; }
}
`;

export function player() {
  type Output = { t: number; type: "stdout" | "stderr"; data: string; bytes: Uint8Array };
  type Resize = { t: number; type: "resize"; cols: number; rows: number };
  type Event = Output | Resize;
  type Change = { start: number; end: number; bytes: number; stderr: boolean };
  type UiSession = {
    sessionId: string; command: string; args: string[]; timestamp: string; exitCode: number | null;
    duration: number; cols: number; rows: number; tty: boolean; speed: number; events: Event[];
    parent: string | null; depth: number; offset: number;
  };
  type UiTree = { speed: number; selected: number; sessions: UiSession[] };
  type Listed = {
    sessionId: string; command: string; args: string[]; timestamp: string; exitCode: number | null;
    total: number; parent: string | null; depth: number;
  };
  type Index = { speed: number; selected: string | null; sessions: Listed[] };
  /** A session of the loaded tree, with its times moved to the tree's clock (ms since the root started). */
  type Loaded = UiSession & { start: number; end: number; outputs: Output[]; changes: Change[]; all: Event[] };

  /** Outputs closer than this (ms) are one change on the timeline. */
  const CHANGE_GAP = 150;
  /** With "Skip pauses", waits longer than this (ms) are cut to it. */
  const MAX_PAUSE = 1000;

  const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const element = (tag: string, className: string, text = "") => {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  };

  const formatTime = (ms: number) => {
    const total = Math.max(0, ms) / 1000;
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = (total % 60).toFixed(3).padStart(6, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
  };
  const formatBytes = (bytes: number) => {
    const units = ["B", "KB", "MB", "GB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return unit === 0 ? `${bytes} B` : `${value.toFixed(1)} ${units[unit]}`;
  };

  const quote = (arg: string) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`);
  const commandLine = (session: { command: string; args: string[] }) =>
    [session.command, ...session.args].map(quote).join(" ");
  const nameOf = (session: { command: string; sessionId: string }) =>
    `${session.command.split("/").at(-1)}[${session.sessionId.slice(0, 8)}]`;
  const exitBadge = (exitCode: number | null) =>
    element("span", `exit ${exitCode === 0 ? "ok" : "fail"}`, exitCode === null ? "running" : `exit ${exitCode}`);

  /** Tree lines (`├─`, `└─`, `│`) before each item of a list in tree order, from its `depth`. */
  const treePrefixes = (items: { depth: number }[]) => {
    const isLast = items.map((item, index) => {
      for (const next of items.slice(index + 1)) {
        if (next.depth < item.depth) return true;
        if (next.depth === item.depth) return false;
      }
      return true;
    });
    const open: boolean[] = [];
    return items.map((item, index) => {
      open.length = item.depth;
      const prefix = open.slice(1).map((more) => (more ? "│  " : "   ")).join("");
      open[item.depth] = !isLast[index];
      return item.depth === 0 ? "" : `${prefix}${isLast[index] ? "└─ " : "├─ "}`;
    });
  };

  const decode = (base64: string) => {
    const text = atob(base64);
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
    return bytes;
  };

  /** Moves a session to the tree's clock and groups its output into changes. */
  const prepare = (session: UiSession): Loaded => {
    const all: Event[] = session.events.map((event) =>
      event.type === "resize"
        ? { ...event, t: event.t + session.offset }
        : { ...event, t: event.t + session.offset, bytes: decode(event.data) },
    );
    const outputs = all.filter((event): event is Output => event.type !== "resize");
    const changes: Change[] = [];
    for (const event of outputs) {
      const last = changes.at(-1);
      if (last && event.t - last.end <= CHANGE_GAP) {
        last.end = event.t;
        last.bytes += event.bytes.length;
        last.stderr ||= event.type === "stderr";
      } else {
        changes.push({ start: event.t, end: event.t, bytes: event.bytes.length, stderr: event.type === "stderr" });
      }
    }
    const start = session.offset;
    const end = Math.max(start + session.duration, all.at(-1)?.t ?? start);
    return { ...session, start, end, outputs, changes, all };
  };

  // Terminal.
  const Terminal = (window as any).Terminal;
  const term = new Terminal({
    cols: 80,
    rows: 24,
    disableStdin: true,
    cursorBlink: false,
    scrollback: 10000,
    fontSize: 14,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
    theme: { background: "#000000" },
  });
  term.open(byId("terminal"));

  // What is loaded: every session of one tree, and the one the terminal shows.
  let sessions: Loaded[] = [];
  let selected = 0;
  let duration = 0;
  const shown = () => sessions[selected];
  const events = () => shown()?.all ?? [];
  const changes = () => shown()?.changes ?? [];

  /**
   * The terminal shows the events of the selected session before `applied`.
   * Seeking forward writes the missing ones; seeking back resets the terminal
   * and writes them again. xterm.js parses writes later, so resets and resizes
   * wait for them in `queue`.
   */
  let applied = 0;
  let queue = Promise.resolve();
  const write = (data: Uint8Array | string) => {
    queue = queue.then(() => new Promise<void>((done) => term.write(data, done)));
  };
  const resize = (cols: number, rows: number) => {
    queue = queue.then(() => term.resize(cols, rows));
  };
  const reset = () => {
    const session = shown();
    write("\x1bc"); // full reset, in order with the writes before it
    if (session) {
      resize(session.cols, session.rows);
      queue = queue.then(() => {
        term.options.convertEol = !session.tty;
      });
    }
    applied = 0;
  };
  /** Number of events of the selected session at or before `time`. */
  const countAt = (time: number) => {
    const list = events();
    let low = 0;
    let high = list.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (list[mid]!.t <= time) low = mid + 1;
      else high = mid;
    }
    return low;
  };
  const render = (time: number) => {
    const list = events();
    const target = countAt(time);
    if (target === applied) return;
    if (target < applied) reset();
    let batch: Uint8Array[] = [];
    const flush = () => {
      if (batch.length === 0) return;
      const size = batch.reduce((sum, bytes) => sum + bytes.length, 0);
      const joined = new Uint8Array(size);
      let offset = 0;
      for (const bytes of batch) {
        joined.set(bytes, offset);
        offset += bytes.length;
      }
      write(joined);
      batch = [];
    };
    for (; applied < target; applied++) {
      const event = list[applied]!;
      if (event.type === "resize") {
        flush();
        resize(event.cols, event.rows);
      } else {
        batch.push(event.bytes);
      }
    }
    flush();
  };

  // Clock.
  let current = 0;
  let playing = false;
  let speed = 1;
  let lastFrame = 0;
  const speedSelect = byId<HTMLSelectElement>("speed");
  const setSpeed = (value: number) => {
    speed = value > 0 && Number.isFinite(value) ? value : 1;
    if (![...speedSelect.options].some((option) => Number(option.value) === speed)) {
      speedSelect.add(new Option(`${speed}×`, String(speed)));
    }
    speedSelect.value = String(speed);
  };
  const skip = byId<HTMLInputElement>("skip");

  const playButton = byId("play");
  const setPlaying = (value: boolean) => {
    playing = value && sessions.length > 0;
    playButton.innerHTML = playing ? "&#x23F8;" : "&#x25B6;";
    playButton.setAttribute("aria-label", playing ? "Pause" : "Play");
    if (playing) {
      if (current >= duration) seek(0);
      lastFrame = performance.now();
      requestAnimationFrame(tick);
    }
  };
  const seek = (time: number) => {
    current = Math.min(duration, Math.max(0, time));
    render(current);
    draw();
  };
  const tick = (now: number) => {
    if (!playing) return;
    let next = current + (now - lastFrame) * speed;
    lastFrame = now;
    if (skip.checked) {
      // Jump over a long wait to just before the next output.
      const upcoming = events()[countAt(current)];
      if (upcoming && upcoming.t - current > MAX_PAUSE && next < upcoming.t) {
        next = Math.max(next, upcoming.t - MAX_PAUSE / 4);
      }
    }
    seek(next);
    if (current >= duration) setPlaying(false);
    else requestAnimationFrame(tick);
  };

  const nextChange = () => {
    const change = changes().find((change) => change.start > current + 1);
    seek(change ? change.end : duration);
  };
  const previousChange = () => {
    const change = changes().findLast((change) => change.end < current - 1);
    seek(change ? change.end : 0);
  };

  // Processes: one row per session of the tree, with a bar from when it started to when it ended.
  const processes = byId("processes");
  const sessionSelect = byId<HTMLSelectElement>("session");
  let processRows: { button: HTMLElement; now: HTMLElement }[] = [];
  const percent = (time: number) => `${duration > 0 ? (time / duration) * 100 : 0}%`;

  const buildProcesses = () => {
    processes.replaceChildren();
    sessionSelect.replaceChildren();
    const prefixes = treePrefixes(sessions);
    processRows = sessions.map((session, index) => {
      const parent = sessions.find((other) => other.sessionId === session.parent);
      const button = document.createElement("button");
      button.title = [
        commandLine(session),
        `started ${formatTime(session.start)} · ran ${formatTime(session.end - session.start)} · ${
          session.exitCode === null ? "running" : `exit ${session.exitCode}`
        }`,
        parent ? `inside ${nameOf(parent)}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      const label = element("span", "label");
      label.append(element("span", "tree", prefixes[index]), element("span", "name", nameOf(session)));
      const track = element("span", "track");
      const bar = element("span", `bar${session.exitCode ? " fail" : ""}`);
      bar.style.left = percent(session.start);
      bar.style.width = `calc(${percent(session.end)} - ${percent(session.start)})`;
      const now = element("span", "now");
      track.append(bar, now);
      button.append(label, track);
      button.addEventListener("click", () => {
        select(index);
        seek(session.start);
        setPlaying(true);
      });
      processes.append(button);
      sessionSelect.add(new Option(`${prefixes[index]}${nameOf(session)}`, String(index)));
      return { button, now };
    });
    processes.hidden = sessions.length < 2;
    processes.parentElement!.classList.toggle("processes", sessions.length > 1);
    sessionSelect.hidden = sessions.length < 2;
  };

  /** Shows the session at `index` of the tree in the terminal, at the current time. */
  const select = (index: number) => {
    selected = index;
    const session = shown()!;
    byId("command").textContent = commandLine(session);
    byId("command").title = byId("command").textContent;
    const meta = byId("meta");
    meta.textContent = `${new Date(session.timestamp).toLocaleString()} · ${session.sessionId.slice(0, 8)}`;
    meta.append(exitBadge(session.exitCode));
    document.title = `binrec play · ${session.command.split("/").at(-1)}`;
    sessionSelect.value = String(index);
    processRows.forEach((row, rowIndex) => row.button.classList.toggle("selected", rowIndex === index));
    reset();
    render(current);
    draw();
  };

  // Timeline.
  const timeline = byId("timeline");
  const canvas = timeline.querySelector("canvas")!;
  const tooltip = byId("tooltip");
  const timeText = byId("time");
  let hover: number | null = null;
  const css = getComputedStyle(document.documentElement);
  const color = (name: string) => css.getPropertyValue(name).trim();

  const draw = () => {
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const x = (time: number) => (duration > 0 ? (time / duration) * width : 0);
    const trackY = height / 2 - 3;

    ctx.fillStyle = color("--border");
    ctx.fillRect(0, trackY, width, 6);
    ctx.fillStyle = color("--played");
    ctx.fillRect(0, 4, x(current), height - 8);
    ctx.fillStyle = color("--accent");
    ctx.fillRect(0, trackY, x(current), 6);

    // When the selected session ran, along the top, when it is not the whole run.
    const session = shown();
    if (session && sessions.length > 1) {
      ctx.fillStyle = color("--process");
      ctx.fillRect(x(session.start), 1, Math.max(2, x(session.end) - x(session.start)), 3);
    }

    // A band under every change, and one tick per output, taller for bigger ones.
    for (const change of changes()) {
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = color(change.stderr ? "--stderr" : "--change");
      ctx.fillRect(x(change.start), trackY - 4, Math.max(3, x(change.end) - x(change.start)), 14);
    }
    const outputs = session?.outputs ?? [];
    const biggest = Math.max(1, ...outputs.map((output) => output.bytes.length));
    for (const output of outputs) {
      const tick = 8 + (height - 16) * Math.min(1, Math.log1p(output.bytes.length) / Math.log1p(biggest));
      ctx.globalAlpha = output.t <= current ? 1 : 0.7;
      ctx.fillStyle = color(output.type === "stderr" ? "--stderr" : "--change");
      ctx.fillRect(Math.round(x(output.t)) - 1, (height - tick) / 2, 2, tick);
    }
    ctx.globalAlpha = 1;

    if (hover !== null) {
      ctx.fillStyle = color("--muted");
      ctx.fillRect(x(hover) - 0.5, 2, 1, height - 4);
    }
    ctx.fillStyle = color("--text");
    ctx.fillRect(x(current) - 1, 0, 2, height);
    ctx.beginPath();
    ctx.arc(x(current), height / 2, 6, 0, Math.PI * 2);
    ctx.fill();

    for (const row of processRows) row.now.style.left = percent(current);

    timeText.textContent = `${formatTime(current)} / ${formatTime(duration)}`;
    timeline.setAttribute("aria-valuemax", String(Math.round(duration)));
    timeline.setAttribute("aria-valuenow", String(Math.round(current)));
    timeline.setAttribute("aria-valuetext", formatTime(current));
  };

  const timeAt = (clientX: number) => {
    const box = canvas.getBoundingClientRect();
    return (Math.min(box.width, Math.max(0, clientX - box.left)) / box.width) * duration;
  };
  let dragging = false;
  let resumeAfterDrag = false;
  timeline.addEventListener("pointerdown", (event) => {
    dragging = true;
    resumeAfterDrag = playing;
    playing = false;
    timeline.setPointerCapture(event.pointerId);
    seek(timeAt(event.clientX));
  });
  timeline.addEventListener("pointermove", (event) => {
    hover = timeAt(event.clientX);
    const box = canvas.getBoundingClientRect();
    tooltip.hidden = false;
    tooltip.style.left = `${(hover / Math.max(1, duration)) * box.width}px`;
    tooltip.textContent = formatTime(hover);
    if (dragging) seek(hover);
    else draw();
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    if (resumeAfterDrag) setPlaying(true);
  };
  timeline.addEventListener("pointerup", endDrag);
  timeline.addEventListener("pointercancel", endDrag);
  timeline.addEventListener("pointerleave", () => {
    hover = null;
    tooltip.hidden = true;
    draw();
  });

  // Controls.
  playButton.addEventListener("click", () => setPlaying(!playing));
  byId("next").addEventListener("click", nextChange);
  byId("prev").addEventListener("click", previousChange);
  speedSelect.addEventListener("change", () => setSpeed(Number(speedSelect.value)));
  sessionSelect.addEventListener("change", () => {
    const index = Number(sessionSelect.value);
    select(index);
    const session = shown()!;
    if (current < session.start || current > session.end) seek(session.start);
  });
  document.addEventListener("keydown", (event) => {
    if (event.target instanceof HTMLSelectElement || event.target instanceof HTMLInputElement) return;
    const step = event.shiftKey ? 10000 : 1000;
    const keys: Record<string, () => void> = {
      " ": () => setPlaying(!playing),
      k: () => setPlaying(!playing),
      ArrowLeft: () => seek(current - step),
      ArrowRight: () => seek(current + step),
      ",": previousChange,
      ".": nextChange,
      Home: () => seek(0),
      End: () => seek(duration),
    };
    const action = keys[event.key];
    if (!action) return;
    event.preventDefault();
    action();
  });
  window.addEventListener("resize", draw);

  // Panel: every recorded session, to pick the one to play.
  const panel = byId("panel");
  const toggle = byId("toggle");
  const list = byId("list");
  const filter = byId<HTMLInputElement>("filter");
  let listed: { session: Listed; button: HTMLElement; root: string }[] = [];
  const setPanel = (open: boolean) => {
    panel.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
  };
  toggle.addEventListener("click", () => setPanel(Boolean(panel.hidden)));

  const markListed = () => {
    const id = shown()?.sessionId;
    const root = sessions[0]?.sessionId;
    for (const item of listed) {
      item.button.classList.toggle("active", item.session.sessionId === id);
      if (item.session.sessionId === root) item.button.scrollIntoView({ block: "nearest" });
    }
  };

  const buildList = (index: Index) => {
    // Newest run first; the sessions of a run keep their order under it.
    const runs: Listed[][] = [];
    for (const session of index.sessions) {
      if (session.depth === 0 || runs.length === 0) runs.push([]);
      runs.at(-1)!.push(session);
    }
    runs.reverse();
    listed = runs.flatMap((run) => {
      const prefixes = treePrefixes(run);
      return run.map((session, index) => {
        const item = document.createElement("li");
        const button = document.createElement("button");
        const row = element("span", "row");
        row.append(element("span", "tree", prefixes[index]), element("span", "name", nameOf(session)), exitBadge(session.exitCode));
        const line = element("span", "line", commandLine(session));
        row.insertBefore(line, row.lastChild);
        const sub = element(
          "span",
          "sub",
          `${"   ".repeat(session.depth)}${new Date(session.timestamp).toLocaleString()} · ${formatBytes(session.total)}`,
        );
        button.append(row, sub);
        button.title = commandLine(session);
        button.addEventListener("click", () => open(session.sessionId));
        item.append(button);
        list.append(item);
        return { session, button, root: run[0]!.sessionId };
      });
    });
    if (listed.length === 0) list.append(element("li", "sub", "No recorded sessions yet."));
  };
  filter.addEventListener("input", () => {
    const text = filter.value.trim().toLowerCase();
    // A run is shown when any of its sessions matches, so the tree stays whole.
    const matching = new Set(
      listed
        .filter(({ session }) => `${session.sessionId} ${commandLine(session)}`.toLowerCase().includes(text))
        .map(({ root }) => root),
    );
    for (const item of listed) item.button.parentElement!.hidden = !matching.has(item.root);
  });

  const empty = byId("empty");
  const screen = byId("screen");

  /** Loads the run session `id` belongs to and plays it from the start of `id`. */
  const open = async (id: string) => {
    const response = await fetch(`/tree.json?id=${encodeURIComponent(id)}`);
    if (!response.ok) {
      byId("command").textContent = `Could not load session ${id}`;
      return;
    }
    const tree: UiTree = await response.json();
    setPlaying(false);
    sessions = tree.sessions.map(prepare);
    duration = Math.max(0, ...sessions.map((session) => session.end));
    current = 0;
    empty.hidden = true;
    screen.hidden = false;
    buildProcesses();
    select(tree.selected);
    seek(shown()!.start);
    markListed();
    history.replaceState(null, "", `?id=${encodeURIComponent(shown()!.sessionId)}`);
    setPlaying(true);
  };

  fetch("/sessions.json")
    .then((response) => response.json())
    .then(async (index: Index) => {
      setSpeed(index.speed);
      buildList(index);
      const id = new URLSearchParams(location.search).get("id") ?? index.selected;
      if (id) {
        await open(id);
      } else {
        empty.hidden = false;
        screen.hidden = true;
        setPanel(true);
        draw();
      }
    })
    .catch((error) => {
      byId("command").textContent = `Could not load the sessions: ${error}`;
    });
}
