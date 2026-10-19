// Drives the page of `binrec play --ui` in a real browser (Chromium through
// playwright-core) and walks every way to move around it: the panel of
// sessions, its filter, the processes of a run, the session selector, the
// timeline, the controls and the keyboard.
import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { $ } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { binrec as lib, type Binrec, type PlayUiServer, type Session } from "../index.ts";

const binrec = new URL("../bin/binrec.ts", import.meta.url).pathname;
const rec = `bun ${binrec} rec`;

let binrecHome: string;
let b: Binrec;
let env: Record<string, string | undefined>;
let browser: Browser;
let server: PlayUiServer;
let page: Page;
let errors: string[];

/** The sessions recorded for these tests: one run of nested `sh`s and a lone `echo`. */
let outer: Session;
let middle: Session;
let leaf: Session;
let lone: Session;

beforeAll(async () => {
  binrecHome = await mkdtemp(join(tmpdir(), "binrec-ui-browser-"));
  b = lib.create({ path: join(binrecHome, "bin") });
  const { BINREC_SESSION: _, ...rest } = process.env;
  env = { ...rest, BINREC_HOME: binrecHome };

  const inner = `echo dentro; sleep 0.2; ${rec} printf 'hoja\\n'; echo err >&2`;
  await $`bun ${binrec} rec sh -c ${`${rec} sh -c "${inner}"; sleep 0.2; echo fin`}`.env(env).quiet();
  await $`bun ${binrec} rec echo solita`.env(env).quiet();
  const found = await b.sessions();
  outer = found.find((session) => session.parent === null && session.args[0] === "-c")!;
  middle = found.find((session) => session.parent === outer.sessionId)!;
  leaf = found.find((session) => session.parent === middle.sessionId)!;
  lone = found.find((session) => session.args[0] === "solita")!;

  browser = await chromium.launch();
  server = await b.playUi(undefined, { speed: 16 });
}, 30000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
  await rm(binrecHome, { recursive: true, force: true });
});

/** Opens the page (at `search`, like `?id=…`) and collects the errors it logs. */
const open = async (search = "") => {
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(new URL(search, server.url).href);
};

afterEach(async () => {
  expect(errors).toEqual([]);
  await page?.close();
});

const short = (session: Session) => session.sessionId.slice(0, 8);
const name = (session: Session) => `${session.command.split("/").at(-1)}[${short(session)}]`;
/** Text on the terminal, one line per row. */
const screen = () => page.locator(".xterm-rows").innerText();
/**
 * Waits until the terminal shows every one of `shown` and none of `hidden`:
 * xterm.js draws what it was given a moment later.
 */
const onScreen = async (shown: string[], hidden: string[] = []) => {
  await page
    .waitForFunction(
      ([shown, hidden]) => {
        const text = (document.querySelector(".xterm-rows") as HTMLElement).innerText;
        return shown!.every((line) => text.includes(line)) && !hidden!.some((line) => text.includes(line));
      },
      [shown, hidden],
      { timeout: 3000 },
    )
    .catch(async () => {
      throw new Error(`terminal shows ${JSON.stringify(await screen())}, wanted ${JSON.stringify({ shown, hidden })}`);
    });
};
const time = () => page.locator("#time").innerText();
/** Waits until the page plays `session`: its command line in the header. */
const showing = async (session: Session) => {
  await page.waitForFunction(
    (line) => document.getElementById("command")?.textContent?.startsWith(line),
    session.command,
  );
  await expect(page.locator("#meta").innerText()).resolves.toContain(short(session));
};
/** Jumps to the end, where the terminal shows the whole output of the selected session. */
const toEnd = async () => {
  await page.locator("#timeline").focus();
  await page.keyboard.press("End");
  await page.waitForFunction(() => {
    const [now, total] = document.getElementById("time")!.textContent!.split(" / ");
    return now === total;
  });
};

test("without an id the page opens on the panel, newest run first, as trees", async () => {
  await open();
  await page.locator("#list button").first().waitFor();

  expect(await page.locator("#panel").isVisible()).toBe(true);
  expect(await page.locator("#toggle").getAttribute("aria-expanded")).toBe("true");
  expect(await page.locator("#empty").isVisible()).toBe(true);
  expect(await page.locator("#screen").isVisible()).toBe(false);
  expect(await page.locator("#processes").isVisible()).toBe(false);
  expect(new URL(page.url()).search).toBe("");

  const rows = await page.locator("#list .row").allTextContents();
  expect(rows).toHaveLength(4);
  expect(rows[0]).toContain(name(lone));
  expect(rows[1]).toContain(name(outer));
  expect(rows[2]).toMatch(new RegExp(`└─ +${name(middle).replace(/[[\]]/g, "\\$&")}`));
  expect(rows[3]).toMatch(new RegExp(`└─ +${name(leaf).replace(/[[\]]/g, "\\$&")}`));
  expect(rows.every((row) => row.includes("exit 0"))).toBe(true);

  // ☰ hides and shows the panel.
  await page.locator("#toggle").click();
  expect(await page.locator("#panel").isVisible()).toBe(false);
  expect(await page.locator("#toggle").getAttribute("aria-expanded")).toBe("false");
  await page.locator("#toggle").click();
  expect(await page.locator("#panel").isVisible()).toBe(true);
});

test("the filter keeps whole runs that have a matching session", async () => {
  await open();
  await page.locator("#list button").first().waitFor();
  const visible = () => page.locator("#list li:visible .name").allInnerTexts();

  await page.locator("#filter").fill("printf");
  expect(await visible()).toEqual([name(outer), name(middle), name(leaf)]);

  await page.locator("#filter").fill(short(lone));
  expect(await visible()).toEqual([name(lone)]);

  await page.locator("#filter").fill("nothing-like-this");
  expect(await visible()).toEqual([]);

  await page.locator("#filter").fill("");
  expect(await visible()).toHaveLength(4);
});

test("picking a run in the panel plays it with a bar per process", async () => {
  await open();
  await page.locator("#list button", { hasText: name(outer) }).click();
  await showing(outer);

  expect(new URL(page.url()).searchParams.get("id")).toBe(outer.sessionId);
  expect(await page.locator("#empty").isVisible()).toBe(false);
  expect(await page.locator("#screen").isVisible()).toBe(true);
  expect(await page.locator("#list button.active .name").innerText()).toBe(name(outer));

  // One row per process, indented under the one it ran inside; the root is selected.
  expect(await page.locator("#processes").isVisible()).toBe(true);
  const labels = await page.locator("#processes .label").allTextContents();
  expect(labels).toEqual([
    name(outer),
    `└─ ${name(middle)}`,
    `   └─ ${name(leaf)}`,
  ]);
  expect(await page.locator("#processes button.selected .name").innerText()).toBe(name(outer));
  expect(await page.locator("#processes button").first().getAttribute("title")).toContain(outer.command);
  expect(await page.locator("#processes button").nth(2).getAttribute("title")).toContain(`inside ${name(middle)}`);

  // Bars follow when each process ran: every child starts after and ends before its parent.
  const bars = await page
    .locator("#processes .bar")
    .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect()));
  expect(bars[0]!.width).toBeGreaterThan(bars[1]!.width);
  expect(bars[1]!.left).toBeGreaterThan(bars[0]!.left);
  expect(bars[2]!.left).toBeGreaterThanOrEqual(bars[1]!.left);
  expect(bars[2]!.right).toBeLessThanOrEqual(bars[1]!.right + 1);
  expect(bars[1]!.right).toBeLessThanOrEqual(bars[0]!.right + 1);

  // The selector in the header lists the same processes.
  expect(await page.locator("#session").isVisible()).toBe(true);
  expect(await page.locator("#session option").allInnerTexts()).toHaveLength(3);
  expect(await page.locator("#session").inputValue()).toBe("0");

  await toEnd();
  await onScreen(["dentro", "hoja", "err", "fin"]);
});

test("a process row and the header selector switch the terminal to that process", async () => {
  await open(`?id=${outer.sessionId}`);
  await showing(outer);

  await page.locator("#processes button").nth(2).click();
  await showing(leaf);
  expect(await page.locator("#session").inputValue()).toBe("2");
  expect(await page.locator("#processes button.selected .name").innerText()).toBe(name(leaf));
  expect(await page.locator("#list button.active .name").innerText()).toBe(name(leaf));
  await toEnd();
  await onScreen(["hoja"], ["dentro"]);

  await page.locator("#session").selectOption("1");
  await showing(middle);
  expect(await page.locator("#processes button.selected .name").innerText()).toBe(name(middle));
  // The run was at its end, after the middle process; picking it jumps to its start.
  expect(await page.locator("#timeline").getAttribute("aria-valuenow")).not.toBe(
    await page.locator("#timeline").getAttribute("aria-valuemax"),
  );
  await toEnd();
  await onScreen(["dentro", "hoja", "err"], ["fin"]);

  await page.locator("#session").selectOption("0");
  await showing(outer);
  await onScreen(["fin"]);
});

test("an id in the address opens the whole run on that session", async () => {
  await open(`?id=${short(leaf)}`);
  await showing(leaf);
  expect(await page.locator("#processes button").count()).toBe(3);
  expect(await page.locator("#session").inputValue()).toBe("2");
  expect(await page.locator("#panel").isVisible()).toBe(false);

  // Picking another session in the panel replaces the run.
  await page.locator("#toggle").click();
  await page.locator("#list button", { hasText: name(lone) }).click();
  await showing(lone);
  expect(new URL(page.url()).searchParams.get("id")).toBe(lone.sessionId);
  expect(await page.locator("#processes").isVisible()).toBe(false);
  expect(await page.locator("#session").isVisible()).toBe(false);
  await toEnd();
  await onScreen(["solita"], ["dentro"]);
});

test("an unknown id says it could not load it", async () => {
  await open("?id=nope");
  await page.waitForFunction(() => document.getElementById("command")?.textContent?.includes("nope"));
  expect(await page.locator("#command").innerText()).toBe("Could not load session nope");
  // The browser logs the 404 of /tree.json; nothing else may fail.
  errors = errors.filter((error) => !error.includes("404"));
});

test("the controls, the timeline and the keyboard move through the run", async () => {
  await open(`?id=${outer.sessionId}`);
  await showing(outer);
  const now = async () => Number(await page.locator("#timeline").getAttribute("aria-valuenow"));
  const total = async () => Number(await page.locator("#timeline").getAttribute("aria-valuemax"));

  // It plays on its own until the end; the button plays it again and pauses it.
  await page.waitForFunction(() => document.getElementById("play")!.getAttribute("aria-label") === "Play");
  expect(await now()).toBe(await total());
  await page.locator("#speed").selectOption("0.25");
  await page.locator("#play").click();
  expect(await page.locator("#play").getAttribute("aria-label")).toBe("Pause");
  expect(await now()).toBeLessThan(await total());
  await page.locator("#play").click();
  expect(await page.locator("#play").getAttribute("aria-label")).toBe("Play");

  // Home and End go to the start and the end.
  await page.locator("#timeline").focus();
  await page.keyboard.press("Home");
  expect(await now()).toBe(0);
  expect(await time()).toStartWith("0:00.000 / ");
  await onScreen([], ["dentro", "fin"]);
  await page.keyboard.press("End");
  expect(await now()).toBe(await total());
  await onScreen(["fin"]);

  // Clicking the timeline jumps there, forward or back.
  const box = (await page.locator("#timeline canvas").boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.25, box.y + box.height / 2);
  const quarter = await now();
  expect(quarter).toBeGreaterThan(0);
  expect(quarter).toBeLessThan(await total());

  // ⏮ and ⏭ jump between changes; so do , and .
  await page.keyboard.press("Home");
  await page.locator("#next").click();
  const first = await now();
  expect(first).toBeGreaterThan(0);
  await onScreen(["dentro"], ["fin"]);
  await page.locator("#timeline").focus();
  await page.keyboard.press(".");
  expect(await now()).toBeGreaterThan(first);
  await page.keyboard.press(",");
  expect(await now()).toBe(first);
  await page.locator("#prev").click();
  expect(await now()).toBe(0);

  // Space plays and pauses; the arrows move a second.
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowLeft");
  expect(await now()).toBe(Math.max(0, (await total()) - 1000));
  await page.keyboard.press("Space");
  expect(await page.locator("#play").getAttribute("aria-label")).toBe("Pause");
  await page.keyboard.press("Space");
  expect(await page.locator("#play").getAttribute("aria-label")).toBe("Play");

  // Space pauses, so the speed picked above is still there.
  expect(await page.locator("#speed").inputValue()).toBe("0.25");
});

test("the speed starts at the one the page was served with", async () => {
  await open(`?id=${lone.sessionId}`);
  await showing(lone);
  expect(await page.locator("#speed").inputValue()).toBe("16");
});

test("a session recorded while the page is open shows up after a reload", async () => {
  await open();
  await page.locator("#list button").first().waitFor();
  expect(await page.locator("#list .row").count()).toBe(4);

  await $`bun ${binrec} rec echo nueva`.env(env).quiet();
  await page.reload();
  await page.locator("#list button").first().waitFor();
  expect(await page.locator("#list .row").count()).toBe(5);
  expect(await page.locator("#list .row").first().innerText()).toContain("echo nueva");
});
