import { afterEach, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandFile, commandScript, syncCommand } from "./command";

const dirs: string[] = [];
function home(): string {
	const dir = mkdtempSync(join(tmpdir(), "upkeep-command-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fake install at `root`: its "bun" prints each argument on its own line, so a test reads what the script ran. */
function fakeInstall(root: string): void {
	mkdirSync(join(root, "app", "bin"), { recursive: true });
	const bun = join(root, "app", "bin", "bun");
	writeFileSync(bun, '#!/bin/sh\nfor a in "$@"; do echo "$a"; done\n');
	chmodSync(bun, 0o755);
}

test("the command sits in ~/.local/bin", () => {
	expect(commandFile("/h")).toBe("/h/.local/bin/upkeep");
});

test("on writes an executable script once, off removes it, and neither repeats work", () => {
	const h = home();
	const file = commandFile(h);
	expect(syncCommand(h, false, "/r")).toBe(false);
	expect(syncCommand(h, true, "/r")).toBe(true);
	expect(readFileSync(file, "utf8")).toBe(commandScript("/r"));
	expect(statSync(file).mode & 0o777).toBe(0o755);
	expect(syncCommand(h, true, "/r")).toBe(false);
	// A moved install rewrites it; no temp file is left behind.
	expect(syncCommand(h, true, "/r2")).toBe(true);
	expect(readFileSync(file, "utf8")).toBe(commandScript("/r2"));
	expect(existsSync(`${file}.upkeep-new`)).toBe(false);
	expect(syncCommand(h, false, "/r2")).toBe(true);
	expect(existsSync(file)).toBe(false);
});

test("an upkeep Upkeep did not write is never rewritten or removed", () => {
	const h = home();
	const file = commandFile(h);
	mkdirSync(join(h, ".local", "bin"), { recursive: true });
	writeFileSync(file, "#!/bin/sh\necho mine\n");
	expect(syncCommand(h, true, "/r")).toBe(false);
	expect(syncCommand(h, false, "/r")).toBe(false);
	expect(readFileSync(file, "utf8")).toBe("#!/bin/sh\necho mine\n");
});

test("a link there, even a dangling one, or a folder, is someone else's", () => {
	const h = home();
	const file = commandFile(h);
	mkdirSync(join(h, ".local", "bin"), { recursive: true });
	symlinkSync(join(h, "nowhere"), file);
	expect(syncCommand(h, true, "/r")).toBe(false);
	expect(existsSync(join(h, "nowhere"))).toBe(false);
	rmSync(file);
	// A link to a file that carries the mark is still not Upkeep's plain file.
	writeFileSync(join(h, "copy"), commandScript("/r"));
	symlinkSync(join(h, "copy"), file);
	expect(syncCommand(h, false, "/r")).toBe(false);
	expect(readFileSync(join(h, "copy"), "utf8")).toBe(commandScript("/r"));
	rmSync(file);
	mkdirSync(file);
	expect(syncCommand(h, true, "/r")).toBe(false);
});

test("the script runs the install's own Bun with no bunfig or .env from the folder, and passes every argument", () => {
	const h = home();
	// A root with a space, a quote and a dollar sign still reaches the shell as one path.
	const root = join(h, "it's a $HOME");
	fakeInstall(root);
	syncCommand(h, true, root);
	const run = Bun.spawnSync(["sh", commandFile(h), "add", "a b", "--json"], { cwd: h });
	expect(run.exitCode).toBe(0);
	expect(run.stdout.toString().split("\n")).toEqual([
		"--config=/dev/null",
		"--no-env-file",
		join(root, "app", "Resources", "app", "cli", "cli.js"),
		"add",
		"a b",
		"--json",
		"",
	]);
});

test("after an uninstall the script says where Upkeep was and exits 127", () => {
	const h = home();
	syncCommand(h, true, join(h, "gone"));
	const run = Bun.spawnSync(["sh", commandFile(h), "check"]);
	expect(run.exitCode).toBe(127);
	expect(run.stderr.toString()).toContain(`Upkeep is not installed at ${join(h, "gone", "app")} any more`);
});
