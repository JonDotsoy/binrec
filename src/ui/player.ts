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
  <span class="brand">binrec</span>
  <code id="command"></code>
  <span id="meta"></span>
</header>
<main><div id="screen"><div id="terminal"></div></div></main>
<footer>
  <div id="timeline" role="slider" tabindex="0" aria-label="Timeline" aria-valuemin="0">
    <canvas></canvas>
    <div id="tooltip" hidden></div>
  </div>
  <ol id="nested" hidden aria-label="Sessions that ran inside this one"></ol>
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
  --nested: #d2a8ff;
}
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body {
  display: flex; flex-direction: column; background: var(--bg); color: var(--text);
  font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
}
header {
  display: flex; align-items: center; gap: 12px; padding: 10px 16px;
  border-bottom: 1px solid var(--border); background: var(--panel); min-width: 0;
}
.brand { font-weight: 600; color: var(--accent); }
#command { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#meta { color: var(--muted); white-space: nowrap; font-size: 12px; }
#meta .exit { padding: 1px 6px; border-radius: 10px; border: 1px solid var(--border); margin-left: 6px; }
#meta .exit.ok { color: var(--change); } #meta .exit.fail { color: var(--stderr); }
main { flex: 1; min-height: 0; overflow: auto; display: flex; padding: 16px; }
#screen {
  margin: auto; padding: 10px; background: #000; border: 1px solid var(--border);
  border-radius: 8px; box-shadow: 0 8px 30px rgba(0, 0, 0, 0.4);
}
footer { border-top: 1px solid var(--border); background: var(--panel); padding: 10px 16px 6px; }
#timeline { position: relative; height: 36px; cursor: pointer; outline: none; touch-action: none; }
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
#nested {
  list-style: none; margin: 6px 0 0; padding: 0; max-height: 120px; overflow: auto;
  font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
#nested button {
  display: flex; gap: 8px; width: 100%; padding: 1px 6px; border: 0; border-radius: 4px;
  background: none; color: var(--muted); font: inherit; text-align: left; cursor: pointer;
}
#nested button:hover { background: var(--bg); }
#nested button.active { color: var(--text); background: rgba(210, 168, 255, 0.12); }
#nested .name { color: var(--nested); white-space: nowrap; }
#nested .line { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#nested .at { font-variant-numeric: tabular-nums; white-space: nowrap; }
.hint { margin: 6px 0 0; color: var(--muted); font-size: 11px; }
`;

export function player() {
  type Output = { t: number; type: "stdout" | "stderr"; data: string; bytes: Uint8Array };
  type Resize = { t: number; type: "resize"; cols: number; rows: number };
  type Event = Output | Resize;
  type Change = { start: number; end: number; bytes: number; stderr: boolean };
  type Nested = {
    sessionId: string; command: string; args: string[]; depth: number; exitCode: number | null;
    start: number; end: number;
  };
  type UiSession = {
    sessionId: string; command: string; args: string[]; timestamp: string; exitCode: number | null;
    duration: number; cols: number; rows: number; tty: boolean; speed: number; events: Event[];
    nested?: Nested[];
  };

  /** Outputs closer than this (ms) are one change on the timeline. */
  const CHANGE_GAP = 150;
  /** With "Skip pauses", waits longer than this (ms) are cut to it. */
  const MAX_PAUSE = 1000;

  const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

  const formatTime = (ms: number) => {
    const total = Math.max(0, ms) / 1000;
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = (total % 60).toFixed(3).padStart(6, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
  };

  const quote = (arg: string) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`);

  const decode = (base64: string) => {
    const text = atob(base64);
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
    return bytes;
  };

  const start = (session: UiSession) => {
    const events: Event[] = session.events.map((event) =>
      event.type === "resize" ? event : { ...event, bytes: decode(event.data) },
    );
    const nested = session.nested ?? [];
    const duration = Math.max(session.duration, events.at(-1)?.t ?? 0, ...nested.map((inner) => inner.end));

    // Header.
    byId("command").textContent = [session.command, ...session.args].map(quote).join(" ");
    byId("command").title = byId("command").textContent;
    const meta = byId("meta");
    meta.textContent = `${new Date(session.timestamp).toLocaleString()} · ${session.sessionId.slice(0, 8)}`;
    const exit = document.createElement("span");
    exit.className = `exit ${session.exitCode === 0 ? "ok" : "fail"}`;
    exit.textContent = session.exitCode === null ? "running" : `exit ${session.exitCode}`;
    meta.append(exit);
    document.title = `binrec play · ${session.command.split("/").at(-1)}`;

    const outputs = events.filter((event): event is Output => event.type !== "resize");

    // Changes: bursts of output, drawn on the timeline and used by previous/next.
    const changes: Change[] = [];
    for (const event of events) {
      if (event.type === "resize") continue;
      const last = changes.at(-1);
      if (last && event.t - last.end <= CHANGE_GAP) {
        last.end = event.t;
        last.bytes += event.bytes.length;
        last.stderr ||= event.type === "stderr";
      } else {
        changes.push({ start: event.t, end: event.t, bytes: event.bytes.length, stderr: event.type === "stderr" });
      }
    }

    // Terminal.
    const Terminal = (window as any).Terminal;
    const term = new Terminal({
      cols: session.cols,
      rows: session.rows,
      convertEol: !session.tty,
      disableStdin: true,
      cursorBlink: false,
      scrollback: 10000,
      fontSize: 14,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      theme: { background: "#000000" },
    });
    term.open(byId("terminal"));

    /**
     * The terminal shows the events before `applied`. Seeking forward writes the
     * missing ones; seeking back resets the terminal and writes them again.
     * xterm.js parses writes later, so resets and resizes wait for them in `queue`.
     */
    let applied = 0;
    let queue = Promise.resolve();
    const write = (data: Uint8Array | string) => {
      queue = queue.then(() => new Promise<void>((done) => term.write(data, done)));
    };
    const resize = (cols: number, rows: number) => {
      queue = queue.then(() => term.resize(cols, rows));
    };
    /** Number of events at or before `time`. */
    const countAt = (time: number) => {
      let low = 0;
      let high = events.length;
      while (low < high) {
        const mid = (low + high) >> 1;
        if (events[mid]!.t <= time) low = mid + 1;
        else high = mid;
      }
      return low;
    };
    const render = (time: number) => {
      const target = countAt(time);
      if (target === applied) return;
      if (target < applied) {
        write("\x1bc"); // full reset, in order with the writes before it
        resize(session.cols, session.rows);
        applied = 0;
      }
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
        const event = events[applied]!;
        if (event.type === "resize") {
          flush();
          resize(event.cols, event.rows);
        } else {
          batch.push(event.bytes);
        }
      }
      flush();
    };

    // Sessions that ran inside this one: a row each, to jump to its start.
    const nestedList = byId("nested");
    const nestedRows = nested.map((inner) => {
      const row = document.createElement("li");
      const button = document.createElement("button");
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = `${"\u00a0\u00a0".repeat(inner.depth - 1)}└ ${inner.command.split("/").at(-1)}[${inner.sessionId.slice(0, 8)}]`;
      const line = document.createElement("span");
      line.className = "line";
      line.textContent = [inner.command, ...inner.args].map(quote).join(" ");
      const at = document.createElement("span");
      at.className = "at";
      at.textContent = `${formatTime(inner.start)} · ${inner.exitCode === null ? "running" : `exit ${inner.exitCode}`}`;
      button.append(name, line, at);
      button.title = line.textContent;
      button.addEventListener("click", () => seek(inner.start));
      row.append(button);
      nestedList.append(row);
      return button;
    });
    nestedList.hidden = nested.length === 0;

    // Clock.
    let current = 0;
    let playing = false;
    let speed = session.speed > 0 && Number.isFinite(session.speed) ? session.speed : 1;
    let lastFrame = 0;
    const speedSelect = byId<HTMLSelectElement>("speed");
    if (![...speedSelect.options].some((option) => Number(option.value) === speed)) {
      speedSelect.add(new Option(`${speed}×`, String(speed)));
    }
    speedSelect.value = String(speed);
    const skip = byId<HTMLInputElement>("skip");

    const playButton = byId("play");
    const setPlaying = (value: boolean) => {
      playing = value;
      playButton.innerHTML = value ? "&#x23F8;" : "&#x25B6;";
      playButton.setAttribute("aria-label", value ? "Pause" : "Play");
      if (value) {
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
        const upcoming = events[countAt(current)];
        if (upcoming && upcoming.t - current > MAX_PAUSE && next < upcoming.t) {
          next = Math.max(next, upcoming.t - MAX_PAUSE / 4);
        }
      }
      seek(next);
      if (current >= duration) setPlaying(false);
      else requestAnimationFrame(tick);
    };

    const nextChange = () => {
      const change = changes.find((change) => change.start > current + 1);
      seek(change ? change.end : duration);
    };
    const previousChange = () => {
      const change = changes.findLast((change) => change.end < current - 1);
      seek(change ? change.end : 0);
    };

    // Timeline.
    const timeline = byId("timeline");
    const canvas = timeline.querySelector("canvas")!;
    const tooltip = byId("tooltip");
    const timeText = byId("time");
    timeline.setAttribute("aria-valuemax", String(Math.round(duration)));
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

      // A band under every change, and one tick per output, taller for bigger ones.
      for (const change of changes) {
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = color(change.stderr ? "--stderr" : "--change");
        ctx.fillRect(x(change.start), trackY - 4, Math.max(3, x(change.end) - x(change.start)), 14);
      }
      const biggest = Math.max(1, ...outputs.map((output) => output.bytes.length));
      for (const output of outputs) {
        const tick = 8 + (height - 16) * Math.min(1, Math.log1p(output.bytes.length) / Math.log1p(biggest));
        ctx.globalAlpha = output.t <= current ? 1 : 0.7;
        ctx.fillStyle = color(output.type === "stderr" ? "--stderr" : "--change");
        ctx.fillRect(Math.round(x(output.t)) - 1, (height - tick) / 2, 2, tick);
      }
      ctx.globalAlpha = 1;

      // A line along the top for every nested session, while it ran.
      ctx.fillStyle = color("--nested");
      for (const inner of nested) {
        ctx.fillRect(x(inner.start), 1, Math.max(2, x(inner.end) - x(inner.start)), 3);
      }
      nested.forEach((inner, index) => {
        nestedRows[index]!.classList.toggle("active", inner.start <= current && current <= inner.end);
      });

      if (hover !== null) {
        ctx.fillStyle = color("--muted");
        ctx.fillRect(x(hover) - 0.5, 2, 1, height - 4);
      }
      ctx.fillStyle = color("--text");
      ctx.fillRect(x(current) - 1, 0, 2, height);
      ctx.beginPath();
      ctx.arc(x(current), height / 2, 6, 0, Math.PI * 2);
      ctx.fill();

      timeText.textContent = `${formatTime(current)} / ${formatTime(duration)}`;
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
    speedSelect.addEventListener("change", () => {
      speed = Number(speedSelect.value);
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

    seek(0);
    setPlaying(true);
  };

  fetch("/session.json")
    .then((response) => response.json())
    .then(start)
    .catch((error) => {
      byId("command").textContent = `Could not load the session: ${error}`;
    });
}
