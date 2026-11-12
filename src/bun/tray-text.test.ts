import { expect, test } from "bun:test";
import { LANGUAGES } from "../shared/languages";
import { autostartEntry } from "./autostart";
import { failedNotice, nameList, readyNotice, updatedNotice } from "./tray-model";
import { count, TRAY_TEXT } from "./tray-text";

test("every language has every tray word, a name slot in the failure line and a # in each count", () => {
	for (const { code } of LANGUAGES) {
		const t = TRAY_TEXT[code];
		for (const [key, v] of Object.entries(t)) {
			if (typeof v === "string") {
				if (key !== "ready") expect(`${code}.${key}: ${v}`).not.toBe(`${code}.${key}: `);
			} else for (const form of Object.values(v)) expect(`${code}.${key}: ${form}`).toContain("#");
		}
		expect(t.failed).toContain("{name}");
	}
});

test("a count takes the form of its plural category, else other", () => {
	const forms = TRAY_TEXT.pl.readyCount;
	expect([1, 3, 5, 22].map((n) => count(n, forms, "pl"))).toEqual([
		"1 aktualizacja gotowa",
		"3 aktualizacje gotowe",
		"5 aktualizacji gotowych",
		"22 aktualizacje gotowe",
	]);
	expect(count(7, TRAY_TEXT.ja.readyCount, "ja")).toBe("7 件の更新");
	expect(count(1, TRAY_TEXT.en.more, "en")).toBe("and 1 more");
});

test("notifications read in the language shown", () => {
	const names = ["a", "b", "c", "d", "e"];
	expect(readyNotice(["fd"], "es")).toBe("1 actualización lista: fd");
	expect(readyNotice(["fd", "bat"], "de")).toBe("2 Aktualisierungen bereit: fd, bat");
	expect(nameList(names, "fr")).toBe("a, b, c, d et 1 de plus");
	expect(updatedNotice(["fd"], "it")).toBe("Aggiornato fd");
	expect(failedNotice("fd", "ru")).toBe("Не удалось обновить fd. Откройте Upkeep, чтобы посмотреть журнал.");
});

test("the login entry carries its comment in every interface language", () => {
	const entry = autostartEntry("/opt/upkeep/launcher", "/opt/upkeep/icon.png");
	expect(entry).toContain("Comment=Check app updates at login and stay in the tray\n");
	expect(entry).toContain(`Comment[ja]=${TRAY_TEXT.ja.loginComment}\n`);
	expect(entry.match(/^Comment\[/gm)?.length).toBe(LANGUAGES.length - 1);
});
