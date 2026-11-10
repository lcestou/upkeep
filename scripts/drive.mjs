// Drives the view over the fixture in Chromium and captures each layout in four states at two sizes.
// Run with real Node: /usr/bin/node scripts/drive.mjs
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5182;
const BASE = `http://127.0.0.1:${PORT}/`;
const OUT = join(ROOT, ".impeccable/review/layouts");
const LAYOUTS = ["a", "b", "c"];
const SIZES = [
	[980, 720],
	[760, 520],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function capture(browser, layout, [width, height], errors) {
	const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, colorScheme: "dark" });
	const page = await ctx.newPage();
	page.on("console", (m) => {
		if (m.type() === "error") errors.push(`${layout} ${width}: ${m.text()}`);
	});
	page.on("pageerror", (e) => errors.push(`${layout} ${width}: ${e.message}`));
	page.on("requestfailed", (r) => errors.push(`${layout} ${width}: request failed ${r.url()}`));
	const shot = (state) => page.screenshot({ path: join(OUT, `${layout}-${state}-${width}.png`) });
	const url = `${BASE}?fixture&layout=${layout}`;

	await page.goto(url);
	const install = page.getByTestId("install");
	await install.waitFor();
	const label = (await install.textContent())?.trim();
	if (label !== "Install 4 updates")
		throw new Error(`${layout} ${width}: install reads "${label}", expected "Install 4 updates"`);
	await page.evaluate(() => document.fonts.ready);
	await sleep(400);
	await shot("ready");

	// Open fd from the keyboard so the focus ring shows.
	await page.getByTestId("open-fd").focus();
	await page.keyboard.press("Enter");
	await page.getByTestId("detail-fd").waitFor();
	await sleep(450);
	await shot("detail");

	await page.goto(url);
	await page.getByTestId("install").waitFor();
	await page.evaluate(() => document.fonts.ready);
	await page.getByTestId("install").click();
	await page.waitForFunction(
		() => Number(document.querySelector('[data-testid="stem-fd"]')?.getAttribute("aria-valuenow") ?? 0) >= 30,
		null,
		{ timeout: 20000 },
	);
	await shot("run");

	await page.waitForFunction(
		() => document.querySelector('[data-testid="state-sentence"]')?.textContent?.trim() === "3 updated, 1 failed",
		null,
		{ timeout: 30000 },
	);
	await sleep(700);
	await shot("summary");
	await ctx.close();
}

async function main() {
	if (await portOpen()) throw new Error(`port ${PORT} is taken; stop whatever listens there first`);
	rmSync(OUT, { recursive: true, force: true });
	mkdirSync(OUT, { recursive: true });

	const vite = spawn("bunx", ["vite", "--port", String(PORT), "--strictPort"], { cwd: ROOT, stdio: "ignore" });
	try {
		await waitFor(portOpen, 30000, "vite on port 5182");
		const browser = await chromium.launch();
		const errors = [];
		let count = 0;
		try {
			for (const layout of LAYOUTS) {
				for (const size of SIZES) {
					// oxlint-disable-next-line no-await-in-loop -- one context at a time keeps the fixture timing honest
					await capture(browser, layout, size, errors);
					count += 4;
				}
			}
		} finally {
			await browser.close();
		}
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
