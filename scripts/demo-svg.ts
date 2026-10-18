/**
 * Renders a recorded session as an animated terminal SVG for the README:
 * each line appears when `binrec play` would write it, then the animation loops.
 *
 *   bun scripts/demo-svg.ts <record.ndjson> <out.svg> [--timestamps]
 */
import { basename } from "node:path";
import { readSession } from "../src/sessions.ts";

const [recordPath, out, flag] = process.argv.slice(2);
if (!recordPath || !out) {
  console.error("Usage: bun scripts/demo-svg.ts <record.ndjson> <out.svg> [--timestamps]");
  process.exit(1);
}
const session = (await readSession(recordPath))!;
const timestamps = flag === "--timestamps";
const id = session.sessionId.slice(0, 8);
const startedAt = session.lines[0]!.performance;

type Row = { at: number; text: string; color: string };
const rows: Row[] = [
  { at: 0, text: `$ binrec play ${timestamps ? "-t " : ""}${id}`, color: "#e6edf3" },
];
const typed = 0.8; // seconds the prompt stays alone before playing
for (const line of session.lines) {
  if (line.type !== "stdout" && line.type !== "stderr" && line.type !== "end") continue;
  const at = typed + (line.performance - startedAt) / 1000;
  const color = line.type === "stderr" ? "#ff7b72" : "#e6edf3";
  const label = (name: string) =>
    `${line.timestamp.slice(11)}  +${(at - typed).toFixed(3)}s  ${name.padEnd(6)}  `;
  if (line.type === "end") {
    if (timestamps) rows.push({ at, text: `${label("exit")}${line.exitCode}`, color: "#8b949e" });
    continue;
  }
  const text = line.data ?? "";
  for (const part of text.replace(/\n$/, "").split("\n")) {
    rows.push({ at, text: timestamps ? `${label(line.type)}${part}` : part, color });
  }
}
rows.push({ at: rows.at(-1)!.at + 0.3, text: "$", color: "#e6edf3" });

const total = rows.at(-1)!.at + 2.5; // hold the end before looping
const escape = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const lineHeight = 20;
const width = Math.max(560, ...rows.map((row) => row.text.length * 8.4 + 40));
const height = 50 + rows.length * lineHeight + 16;

const styles = rows
  .flatMap((row, index) => {
    if (row.at === 0) return []; // shown from the start
    const start = (row.at / total) * 100;
    return `@keyframes l${index}{0%,${start.toFixed(2)}%{opacity:0}${(start + 0.01).toFixed(2)}%,100%{opacity:1}}
.l${index}{animation:l${index} ${total.toFixed(2)}s steps(1,end) infinite}`;
  })
  .join("\n");

const text = rows
  .map(
    (row, index) =>
      `<text class="l${index}" x="20" y="${56 + index * lineHeight}" fill="${row.color}" xml:space="preserve">${escape(row.text)}</text>`,
  )
  .join("\n");

await Bun.write(
  out,
  `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(width)}" height="${height}" viewBox="0 0 ${Math.ceil(width)} ${height}" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="14">
<style>
${styles}
</style>
<rect width="100%" height="100%" rx="8" fill="#0d1117"/>
<circle cx="20" cy="18" r="6" fill="#ff5f57"/><circle cx="40" cy="18" r="6" fill="#febc2e"/><circle cx="60" cy="18" r="6" fill="#28c840"/>
<text x="${Math.ceil(width) / 2}" y="22" fill="#8b949e" font-size="12" text-anchor="middle">${escape(basename(out, ".svg"))}</text>
${text}
</svg>
`,
);
console.log(`Wrote ${out} (${total.toFixed(1)}s loop)`);
