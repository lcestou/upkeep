// Drives the view over the fixture in Chromium, captures every state, and measures the ledger.
// Run with real Node: /usr/bin/node scripts/drive.mjs
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// The main checkout and a worktree can run side by side on different ports.
const PORT = Number(process.env.UPKEEP_E2E_PORT) || 5182;
const BASE = `http://127.0.0.1:${PORT}/`;
const OUT = join(ROOT, ".impeccable/review");
const SIZES = [
	[980, 720],
	[760, 520],
];
const BIG = [1400, 900];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fig = (v, w) => (v === 999 ? "-" : v.toFixed(v >= 100 ? 0 : 2)).padStart(w);

function portOpen() {
	return new Promise((resolve) => {
		const socket = connect(PORT, "127.0.0.1");
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => resolve(false));
	});
}

async function waitFor(check, ms, what) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		// oxlint-disable-next-line no-await-in-loop -- polling
		if (await check()) return;
		// oxlint-disable-next-line no-await-in-loop -- polling
		await sleep(150);
	}
	throw new Error(`timed out waiting for ${what}`);
}

/** bunx may leave vite as its own child, so the listener's pid is read from ss and stopped too. */
function listenerPid() {
	try {
		const out = execFileSync("ss", ["-ltnpH", `sport = :${PORT}`], { encoding: "utf8" });
		const m = out.match(/pid=(\d+)/);
		return m ? Number(m[1]) : null;
	} catch {
		return null;
	}
}

async function stopVite(child) {
	const pid = listenerPid();
	if (child.exitCode === null) child.kill("SIGTERM");
	if (pid && pid !== child.pid) {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			// already gone
		}
	}
	await waitFor(async () => !(await portOpen()), 5000, "vite to stop").catch(() => {});
}

const sentenceIs = (page, text, timeout = 30000) =>
	page.waitForFunction(
		(t) => document.querySelector('[data-testid="state-sentence"]')?.textContent?.trim() === t,
		text,
		{
			timeout,
		},
	);

const midRun = (page) =>
	page.waitForFunction(
		() => {
			const stem = document.querySelector('[data-testid="row-fd"] [data-testid="stem-fd"]');
			return Number(stem?.getAttribute("aria-valuenow") ?? 0) >= 30;
		},
		null,
		{ timeout: 20000 },
	);

// oxlint-disable unicorn/consistent-function-scoping -- measure() is serialised into the page, so its helpers must live inside it.
/**
 * Runs in the page. Reads every visible ledger row and returns the misses of five checks:
 * a column edges agree, b status text and stem share a left edge, c text sits centred in its row,
 * d no text overflows its cell, e text and glyph contrast.
 */
function measure() {
	const misses = [];
	const worst = { a: 0, b: 0, c: 0, d: 0, e: 99, f: 0, g: 999, h: 0, i: 0 };
	const list = document.querySelector('[data-testid="app-list"]');
	if (!list) return { misses: ["no list"], worst, rows: 0 };
	const view = list.getBoundingClientRect();
	const visible = (r) => r.width > 0 && r.height > 0 && r.top >= view.top + 30 && r.bottom <= view.bottom;
	const rows = [...list.querySelectorAll(".row")].filter((r) => visible(r.getBoundingClientRect()));
	const textBox = (el) => {
		const range = document.createRange();
		range.selectNodeContents(el);
		return range.getBoundingClientRect();
	};

	// a: one left edge (right edge for Size) per column across rows, and the column heads on the same edges.
	const cols = {};
	const edge = (cls, side) => (cols[cls] ??= { side, xs: [] });
	for (const row of rows) {
		for (const cls of ["mark", "name", "kind", "restore", "status"]) {
			const cell = row.querySelector(`.${cls}`);
			if (cell && cell.getBoundingClientRect().width > 0)
				edge(cls, "left").xs.push([row, cell.getBoundingClientRect().left]);
		}
		const size = row.querySelector(".size");
		if (size && size.getBoundingClientRect().width > 0 && size.textContent.trim())
			edge("size text", "right").xs.push([row, textBox(size).right]);
		const arrow = row.querySelector(".arrow");
		if (arrow) {
			const r = arrow.getBoundingClientRect();
			edge("version arrow", "centre").xs.push([row, r.left + r.width / 2]);
		}
	}
	const heads = {
		name: ".h-name",
		kind: ".h-kind",
		restore: ".h-restore",
		status: ".h-status",
		"size text": ".h-size",
		"version arrow": ".h-ver",
	};
	for (const [name, { side, xs }] of Object.entries(cols)) {
		const values = xs.map(([, x]) => x);
		const spread = Math.max(...values) - Math.min(...values);
		worst.a = Math.max(worst.a, spread);
		if (spread > 1) misses.push(`a ${name}: edges spread ${spread.toFixed(2)} px across ${values.length} rows`);
		const head = heads[name] && list.querySelector(heads[name]);
		if (head && head.getBoundingClientRect().width > 0 && values.length > 0) {
			const t = textBox(head);
			const hx = side === "right" ? t.right : side === "centre" ? t.left + t.width / 2 : t.left;
			const cx = values[0];
			// Text columns: the head's text starts where the cell's content starts (cells start at the padding edge).
			const pad =
				name === "restore" ? Number.parseFloat(getComputedStyle(rows[0].querySelector(".restore")).paddingLeft) : 0;
			const off = Math.abs(hx - (cx + pad));
			worst.a = Math.max(worst.a, off);
			if (off > 1) misses.push(`a head ${name}: off its column by ${off.toFixed(2)} px`);
		}
	}

	// f: one version axis: every installed version ends, and every latest version starts, on the same x.
	for (const [sel, side] of [
		[".ver .installed", "right"],
		[".ver .latest", "left"],
	]) {
		// Every row of every group, on screen or not: the axis must hold down the whole list.
		const xs = [...list.querySelectorAll(".row")].flatMap((row) => {
			const el = row.querySelector(sel);
			return el && el.textContent.trim() ? [el.getBoundingClientRect()[side]] : [];
		});
		if (xs.length < 2) continue;
		const spread = Math.max(...xs) - Math.min(...xs);
		worst.f = Math.max(worst.f, spread);
		if (spread > 1) misses.push(`f ${sel}: ${side} edges spread ${spread.toFixed(2)} px across ${xs.length} rows`);
	}

	// g: no stem stage is drawn narrower than 28 px. h: the gap from the name column to the version column.
	for (const row of rows) {
		for (const span of row.querySelectorAll(".stem .span")) {
			const w = span.getBoundingClientRect().width;
			worst.g = Math.min(worst.g, w);
			if (w < 27.5) misses.push(`g ${row.dataset.testid}: a stem stage is ${w.toFixed(1)} px wide`);
		}
		const name = row.querySelector(".name");
		const ver = row.querySelector(".ver");
		if (name && ver && ver.getBoundingClientRect().width > 0) {
			const gap = ver.getBoundingClientRect().left - name.getBoundingClientRect().right;
			worst.h = Math.max(worst.h, gap);
			if (gap > 260) misses.push(`h ${row.dataset.testid}: ${gap.toFixed(0)} px between the name and version columns`);
		}
	}

	// i: the inspector never scrolls sideways.
	const paneScroll = document.querySelector('[data-testid="inspector"] .scroll');
	if (paneScroll) {
		const over = paneScroll.scrollWidth - paneScroll.clientWidth;
		worst.i = Math.max(worst.i, over);
		if (over > 0) misses.push(`i inspector: scrolls ${over} px sideways`);
	}

	// b: the stem and the status text start at the status cell's left edge.
	for (const row of rows) {
		const cell = row.querySelector(".status");
		const first = cell && [...cell.children].find((c) => !c.classList.contains("sr-only"));
		if (!cell || !first) continue;
		const target = first.classList.contains("stem") ? first.querySelector(".track") : first;
		const off = Math.abs((target ?? first).getBoundingClientRect().left - cell.getBoundingClientRect().left);
		worst.b = Math.max(worst.b, off);
		if (off > 1) misses.push(`b ${row.dataset.testid}: status content starts ${off.toFixed(2)} px off the column`);
	}

	// c: the row's text block is centred, equal space above and below within 1 px.
	for (const row of rows) {
		const r = row.getBoundingClientRect();
		// The name block is the tag name plus its sentence; a repo wrapped out of sight is not part of it.
		const name = row.querySelector(".tag-name");
		const said = row.querySelector(".sentence");
		// A clamped reason shows only its first lines: measure the box it draws, not the full text.
		const saidBottom = said ? Math.min(textBox(said).bottom, said.getBoundingClientRect().bottom) : null;
		const blocks = [name && { sel: "name", top: textBox(name).top, bottom: saidBottom ?? textBox(name).bottom }];
		for (const sel of [".ver .installed", ".ver .versionless", ".status .status-text", ".status .command", ".kind"]) {
			const el = row.querySelector(sel);
			if (!el || el.getBoundingClientRect().width === 0 || !el.textContent.trim()) continue;
			const t = textBox(el);
			blocks.push({ sel, top: t.top, bottom: t.bottom });
		}
		for (const block of blocks) {
			if (!block) continue;
			const { sel } = block;
			const top = block.top - r.top;
			const bottom = r.bottom - block.bottom;
			const diff = Math.abs(top - bottom);
			worst.c = Math.max(worst.c, diff);
			if (diff > 1) misses.push(`c ${row.dataset.testid} ${sel}: ${top.toFixed(1)} above, ${bottom.toFixed(1)} below`);
		}
	}

	// d: no text node draws past its cell, unless it ends in a deliberate ellipsis or is clipped out of sight.
	const clipOf = (el) => {
		for (let n = el; n && n !== list; n = n.parentElement) {
			const s = getComputedStyle(n);
			if (s.overflow !== "visible" || s.overflowX !== "visible") return n.getBoundingClientRect();
		}
		return null;
	};
	for (const row of rows) {
		for (const cell of row.querySelectorAll(".cell")) {
			const c = cell.getBoundingClientRect();
			if (c.width === 0) continue;
			const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
			for (let node = walker.nextNode(); node; node = walker.nextNode()) {
				const el = node.parentElement;
				if (!node.textContent.trim() || !el || el.closest(".sr-only")) continue;
				const range = document.createRange();
				range.selectNodeContents(node);
				const t = range.getBoundingClientRect();
				if (t.width === 0) continue;
				const clip = clipOf(el);
				if (clip && (t.top >= clip.bottom - 0.5 || t.left >= clip.right - 0.5)) continue;
				const style = getComputedStyle(el);
				if (style.textOverflow === "ellipsis" || style.webkitLineClamp !== "none") continue;
				const over = Math.max(c.left - t.left, t.right - c.right, c.top - t.top, t.bottom - c.bottom);
				worst.d = Math.max(worst.d, over);
				if (over > 0.5)
					misses.push(
						`d ${row.dataset.testid}: "${node.textContent.trim()}" overflows its cell by ${over.toFixed(1)} px`,
					);
			}
		}
	}

	// e: contrast of every visible text node and glyph, blended through opacity onto the real background.
	const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
	const rgba = (css) => {
		ctx.clearRect(0, 0, 1, 1);
		ctx.fillStyle = "#000";
		ctx.fillStyle = css;
		ctx.fillRect(0, 0, 1, 1);
		const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
		return [r, g, b, a / 255];
	};
	const over = (top, a, under) => [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a));
	const lum = ([r, g, b]) => {
		const f = (v) => {
			const c = v / 255;
			return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
		};
		return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
	};
	const ratio = (x, y) => {
		const [hi, lo] = [lum(x), lum(y)].toSorted((p, q) => q - p);
		return (hi + 0.05) / (lo + 0.05);
	};
	const colours = (el, colour) => {
		const chain = [];
		for (let n = el; n; n = n.parentElement) chain.unshift(n);
		let bg = [255, 255, 255];
		let opacity = 1;
		for (const n of chain) {
			const s = getComputedStyle(n);
			opacity *= Number(s.opacity);
			const [r, g, b, a] = rgba(s.backgroundColor);
			if (a > 0) bg = over([r, g, b], a * opacity, bg);
		}
		const [r, g, b, a] = rgba(colour);
		return { fg: over([r, g, b], a * opacity, bg), bg };
	};
	const inactive = (el) => el.closest(":disabled, [aria-disabled='true']") !== null;
	const scope = [
		list,
		document.querySelector("header"),
		document.querySelector("footer"),
		document.querySelector('[data-testid="inspector"]'),
	];
	for (const root of scope) {
		if (!root) continue;
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			const el = node.parentElement;
			if (!node.textContent.trim() || !el || el.closest(".sr-only") || inactive(el)) continue;
			const range = document.createRange();
			range.selectNodeContents(node);
			const t = range.getBoundingClientRect();
			if (t.width === 0 || (root === list && !visible(t))) continue;
			const s = getComputedStyle(el);
			const px = Number.parseFloat(s.fontSize);
			const large = px >= 24 || (px >= 18.66 && Number(s.fontWeight) >= 700);
			const { fg, bg } = colours(el, s.color);
			const got = ratio(fg, bg);
			const need = large ? 3 : 4.5;
			worst.e = Math.min(worst.e, got / need);
			if (got < need) misses.push(`e "${node.textContent.trim().slice(0, 32)}": ${got.toFixed(2)}:1, needs ${need}:1`);
		}
		for (const glyph of root.querySelectorAll("svg.glyph")) {
			const g = glyph.getBoundingClientRect();
			if (g.width === 0 || (root === list && !visible(g)) || inactive(glyph)) continue;
			const { fg, bg } = colours(glyph, getComputedStyle(glyph).color);
			const got = ratio(fg, bg);
			worst.e = Math.min(worst.e, got / 3);
			if (got < 3)
				misses.push(`e glyph in ${glyph.closest("[data-testid]")?.dataset.testid}: ${got.toFixed(2)}:1, needs 3:1`);
		}
	}
	return { misses, worst, rows: rows.length };
}

// oxlint-enable unicorn/consistent-function-scoping

async function shoot(page, name) {
	await sleep(350);
	await page.screenshot({ path: join(OUT, `${name}.png`) });
}

async function captureSize(browser, [width, height], errors, table, { full }) {
	const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, colorScheme: "dark" });
	const page = await ctx.newPage();
	page.on("console", (m) => {
		if (m.type() === "error") errors.push(`${width}: ${m.text()}`);
	});
	page.on("pageerror", (e) => errors.push(`${width}: ${e.message}`));
	page.on("requestfailed", (r) => errors.push(`${width}: request failed ${r.url()}`));
	const go = async (query) => {
		await page.goto(`${BASE}?${query}`);
		await page.getByTestId("state-sentence").waitFor();
		await page.evaluate(() => document.fonts.ready);
	};
	const measured = async (state) => {
		const res = await page.evaluate(measure);
		table.push({ state: `${state}-${width}`, ...res });
	};

	await go("fixture");
	const label = (await page.getByTestId("install").textContent())?.trim();
	if (label !== "Install 4 updates")
		throw new Error(`${width}: install reads "${label}", expected "Install 4 updates"`);
	await shoot(page, `ready-${width}`);
	await measured("ready");

	// Every group open, so the version axis is measured across all of them.
	await page.getByTestId("group-fresh-toggle").click();
	await page.getByTestId("open-wrangler").hover();
	await sleep(400);
	await measured("ready+fresh+hover");
	await page.getByTestId("group-fresh-toggle").click();

	await page.getByTestId("open-fd").focus();
	await page.keyboard.press("Enter");
	await page.getByTestId("detail-fd").waitFor();
	if (full) await shoot(page, `pane-${width}`);
	await sleep(200);
	await measured("pane");
	await page.keyboard.press("Escape");

	await page.getByTestId("install").click();
	await midRun(page);
	await shoot(page, `run-${width}`);
	await measured("run");
	if (!full) {
		await ctx.close();
		return 2;
	}

	await go("fixture");
	await page.getByTestId("open-fd").click();
	await page.getByTestId("install").click();
	await midRun(page);
	await shoot(page, `run-pane-${width}`);
	await measured("run+pane");
	await sentenceIs(page, "3 updated, 1 failed");
	await page.getByTestId("detail-wrangler").waitFor();
	await shoot(page, `summary-failed-${width}`);
	await measured("summary+pane");

	await go("fixture&speed=3");
	await page.getByTestId("tick-wrangler").click();
	await page.getByTestId("install").click();
	await sentenceIs(page, "3 updated");
	await shoot(page, `summary-clean-${width}`);

	await go("fixture");
	await page.getByTestId("tab-history").click();
	await shoot(page, `history-${width}`);
	await page.getByTestId("tab-settings").click();
	await shoot(page, `settings-${width}`);

	for (const variant of ["empty", "checking", "problems"]) {
		// oxlint-disable-next-line no-await-in-loop -- one page, one state at a time
		await go(`fixture=${variant}`);
		// oxlint-disable-next-line no-await-in-loop -- one page, one state at a time
		await shoot(page, `${variant}-${width}`);
	}
	await go("fixture=many");
	await page.getByTestId("group-fresh-toggle").click();
	await page.getByTestId("app-list").evaluate((el) => {
		el.scrollTop = (el.scrollHeight - el.clientHeight) / 2;
	});
	await shoot(page, `many-${width}`);
	await ctx.close();
	return 12;
}

async function main() {
	if (await portOpen()) throw new Error(`port ${PORT} is taken; stop whatever listens there first`);
	mkdirSync(OUT, { recursive: true });
	for (const f of readdirSync(OUT)) if (f.endsWith(".png")) rmSync(join(OUT, f));
	rmSync(join(OUT, "layouts"), { recursive: true, force: true });

	const vite = spawn(
		process.execPath,
		[join(ROOT, "node_modules/vite/bin/vite.js"), "--port", String(PORT), "--strictPort"],
		{ cwd: ROOT, stdio: "ignore" },
	);
	try {
		await waitFor(portOpen, 30000, `vite on port ${PORT}`);
		const browser = await chromium.launch();
		const errors = [];
		const table = [];
		let count = 0;
		try {
			for (const size of SIZES) {
				// oxlint-disable-next-line no-await-in-loop -- one context at a time keeps the fixture timing honest
				count += await captureSize(browser, size, errors, table, { full: true });
			}
			count += await captureSize(browser, BIG, errors, table, { full: false });
		} finally {
			await browser.close();
		}
		console.log("state               rows  a cols  b stat  c centre  d over  e contr  f axis  g stem  h gap  i pane-x");
		for (const t of table) {
			const w = t.worst;
			console.log(
				`${t.state.padEnd(19)} ${String(t.rows).padStart(4)}  ${fig(w.a, 6)}  ${fig(w.b, 6)}  ${fig(w.c, 8)}  ${fig(w.d, 6)}  ${fig(w.e, 7)}  ${fig(w.f, 6)}  ${fig(w.g, 6)}  ${fig(w.h, 5)}  ${fig(w.i, 7)}`,
			);
		}
		const misses = table.flatMap((t) => t.misses.map((m) => `${t.state}: ${m}`));
		if (misses.length > 0) throw new Error(`measured misses (${misses.length}):\n${misses.slice(0, 40).join("\n")}`);
		if (errors.length > 0) throw new Error(`console errors:\n${errors.join("\n")}`);
		console.log(`drive ok: ${count} captures`);
	} finally {
		await stopVite(vite);
	}
}

main().catch((e) => {
	console.error(`drive failed: ${e instanceof Error ? e.message : String(e)}`);
	process.exit(1);
});
