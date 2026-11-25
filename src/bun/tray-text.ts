import type { LanguageCode } from "../shared/languages";

/** A count's wording by plural category; `#` stands for the number. Every language needs `other`. */
type Forms = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string };

/** The words the tray menu, its accessible title, the login entry and the notifications use, in one language. */
export type TrayText = {
	open: string;
	check: string;
	/** "Install 3 ready". */
	installReady: Forms;
	/** "System updates: 12"; the number is drawn after the colon in every language. */
	systemUpdates: string;
	quitAfterRun: string;
	quit: string;
	/** The icon's accessible name with updates ready: "Upkeep, 3 updates ready". */
	titleReady: Forms;
	/** The tail of a cut name list: "and 3 more". */
	more: Forms;
	/** A ready notification's count: "3 updates", before ": " and the names. */
	readyCount: Forms;
	/** "ready", after the count. Empty where the count's own words already say it. */
	ready: string;
	/** "Updated", before the names. */
	updated: string;
	/** "{name} failed to update. Open Upkeep for the log." */
	failed: string;
	/** The login entry's Comment. */
	loginComment: string;
	/** A new version of Upkeep itself is there: the tray menu's line and the notification. "{version}" is its number. */
	selfReady: string;
	/** A ready notice's second line when the automatic apps wait for an unmetered connection. */
	waitsMetered: string;
	/** A ready notice's second line when the automatic apps wait for mains power. */
	waitsBattery: string;
};

/**
 * The tray's words for every interface language. The Bun process is never built by Vite, so wuchale cannot reach
 * these; the type makes a missing language or key a type error instead of an English gap. Keep them in step with
 * the view's catalogs by hand.
 */
export const TRAY_TEXT = {
	en: {
		open: "Open Upkeep",
		check: "Check now",
		installReady: { other: "Install # ready" },
		systemUpdates: "System updates",
		quitAfterRun: "Quit after this run",
		quit: "Quit",
		titleReady: { one: "Upkeep, # update ready", other: "Upkeep, # updates ready" },
		more: { other: "and # more" },
		readyCount: { one: "# update", other: "# updates" },
		ready: "ready",
		updated: "Updated",
		failed: "{name} failed to update. Open Upkeep for the log.",
		loginComment: "Check app updates at login and stay in the tray",
		selfReady: "Upkeep {version} is ready",
		waitsMetered: "Automatic updates wait for an unmetered connection.",
		waitsBattery: "Automatic updates wait for mains power.",
	},
	zh: {
		open: "打开 Upkeep",
		check: "立即检查",
		installReady: { other: "安装 # 个就绪的更新" },
		systemUpdates: "系统更新",
		quitAfterRun: "本次运行结束后退出",
		quit: "退出",
		titleReady: { other: "Upkeep，# 个更新就绪" },
		more: { other: "等另外 # 个" },
		readyCount: { other: "# 个更新" },
		ready: "就绪",
		updated: "已更新",
		failed: "{name} 更新失败。打开 Upkeep 查看日志。",
		loginComment: "登录时检查应用更新并留在托盘中",
		selfReady: "Upkeep {version} 已可更新",
		waitsMetered: "自动更新正在等待非计量连接。",
		waitsBattery: "自动更新正在等待交流电源。",
	},
	es: {
		open: "Abrir Upkeep",
		check: "Buscar ahora",
		installReady: { other: "Instalar # listas" },
		systemUpdates: "Actualizaciones del sistema",
		quitAfterRun: "Salir al terminar esta tanda",
		quit: "Salir",
		titleReady: { one: "Upkeep, # actualización lista", other: "Upkeep, # actualizaciones listas" },
		more: { other: "y # más" },
		readyCount: { one: "# actualización lista", other: "# actualizaciones listas" },
		ready: "",
		updated: "Actualizado",
		failed: "No se pudo actualizar {name}. Abre Upkeep para ver el registro.",
		loginComment: "Buscar actualizaciones de apps al iniciar sesión y quedarse en la bandeja",
		selfReady: "Upkeep {version} está listo",
		waitsMetered: "Las actualizaciones automáticas esperan una conexión sin límite de datos.",
		waitsBattery: "Las actualizaciones automáticas esperan a la corriente.",
	},
	pt: {
		open: "Abrir o Upkeep",
		check: "Verificar agora",
		installReady: { other: "Instalar # prontas" },
		systemUpdates: "Atualizações do sistema",
		quitAfterRun: "Sair ao fim desta execução",
		quit: "Sair",
		titleReady: { one: "Upkeep, # atualização pronta", other: "Upkeep, # atualizações prontas" },
		more: { other: "e mais #" },
		readyCount: { one: "# atualização pronta", other: "# atualizações prontas" },
		ready: "",
		updated: "Atualizado",
		failed: "Não foi possível atualizar {name}. Abra o Upkeep para ver o registro.",
		loginComment: "Verificar atualizações de apps ao entrar e ficar na bandeja",
		selfReady: "O Upkeep {version} está pronto",
		waitsMetered: "As atualizações automáticas esperam por uma ligação sem limite de dados.",
		waitsBattery: "As atualizações automáticas esperam pela corrente.",
	},
	de: {
		open: "Upkeep öffnen",
		check: "Jetzt prüfen",
		installReady: { other: "# bereite installieren" },
		systemUpdates: "Systemaktualisierungen",
		quitAfterRun: "Nach diesem Durchlauf beenden",
		quit: "Beenden",
		titleReady: { one: "Upkeep, # Aktualisierung bereit", other: "Upkeep, # Aktualisierungen bereit" },
		more: { other: "und # weitere" },
		readyCount: { one: "# Aktualisierung", other: "# Aktualisierungen" },
		ready: "bereit",
		updated: "Aktualisiert",
		failed: "{name} konnte nicht aktualisiert werden. Öffne Upkeep für das Protokoll.",
		loginComment: "Beim Anmelden nach App-Aktualisierungen suchen und im Tray bleiben",
		selfReady: "Upkeep {version} ist bereit",
		waitsMetered: "Automatische Aktualisierungen warten auf eine nicht getaktete Verbindung.",
		waitsBattery: "Automatische Aktualisierungen warten auf Netzstrom.",
	},
	fr: {
		open: "Ouvrir Upkeep",
		check: "Vérifier maintenant",
		installReady: { one: "Installer # prête", other: "Installer # prêtes" },
		systemUpdates: "Mises à jour du système",
		quitAfterRun: "Quitter après cette passe",
		quit: "Quitter",
		titleReady: { one: "Upkeep, # mise à jour prête", other: "Upkeep, # mises à jour prêtes" },
		more: { other: "et # de plus" },
		readyCount: { one: "# mise à jour prête", other: "# mises à jour prêtes" },
		ready: "",
		updated: "Mis à jour",
		failed: "La mise à jour de {name} a échoué. Ouvrez Upkeep pour voir le journal.",
		loginComment: "Vérifier les mises à jour des applications à la connexion et rester dans la zone de notification",
		selfReady: "Upkeep {version} est prêt",
		waitsMetered: "Les mises à jour automatiques attendent une connexion non limitée.",
		waitsBattery: "Les mises à jour automatiques attendent le secteur.",
	},
	it: {
		open: "Apri Upkeep",
		check: "Controlla ora",
		installReady: { one: "Installa # pronto", other: "Installa # pronti" },
		systemUpdates: "Aggiornamenti di sistema",
		quitAfterRun: "Esci al termine di questa sessione",
		quit: "Esci",
		titleReady: { one: "Upkeep, # aggiornamento pronto", other: "Upkeep, # aggiornamenti pronti" },
		more: { other: "e altri #" },
		readyCount: { one: "# aggiornamento pronto", other: "# aggiornamenti pronti" },
		ready: "",
		updated: "Aggiornato",
		failed: "Impossibile aggiornare {name}. Apri Upkeep per il registro.",
		loginComment: "Controlla gli aggiornamenti delle app all'accesso e resta nell'area di notifica",
		selfReady: "Upkeep {version} è pronto",
		waitsMetered: "Gli aggiornamenti automatici attendono una connessione non a consumo.",
		waitsBattery: "Gli aggiornamenti automatici attendono l'alimentazione di rete.",
	},
	pl: {
		open: "Otwórz Upkeep",
		check: "Sprawdź teraz",
		installReady: { other: "Zainstaluj gotowe: #" },
		systemUpdates: "Aktualizacje systemu",
		quitAfterRun: "Zakończ po tym przebiegu",
		quit: "Zakończ",
		titleReady: {
			one: "Upkeep, # aktualizacja gotowa",
			few: "Upkeep, # aktualizacje gotowe",
			many: "Upkeep, # aktualizacji gotowych",
			other: "Upkeep, # aktualizacji gotowych",
		},
		more: { other: "i # więcej" },
		readyCount: {
			one: "# aktualizacja gotowa",
			few: "# aktualizacje gotowe",
			many: "# aktualizacji gotowych",
			other: "# aktualizacji gotowych",
		},
		ready: "",
		updated: "Zaktualizowano",
		failed: "Nie udało się zaktualizować {name}. Otwórz Upkeep, aby zobaczyć dziennik.",
		loginComment: "Sprawdzaj aktualizacje aplikacji po zalogowaniu i zostań w zasobniku",
		selfReady: "Upkeep {version} jest gotowy",
		waitsMetered: "Automatyczne aktualizacje czekają na połączenie bez limitu.",
		waitsBattery: "Automatyczne aktualizacje czekają na zasilanie sieciowe.",
	},
	ru: {
		open: "Открыть Upkeep",
		check: "Проверить сейчас",
		installReady: { other: "Установить готовые: #" },
		systemUpdates: "Обновления системы",
		quitAfterRun: "Выйти после этого прохода",
		quit: "Выйти",
		titleReady: {
			one: "Upkeep, # обновление готово",
			few: "Upkeep, # обновления готовы",
			many: "Upkeep, # обновлений готово",
			other: "Upkeep, # обновления готовы",
		},
		more: { other: "и ещё #" },
		readyCount: {
			one: "# обновление готово",
			few: "# обновления готовы",
			many: "# обновлений готово",
			other: "# обновления готовы",
		},
		ready: "",
		updated: "Обновлено",
		failed: "Не удалось обновить {name}. Откройте Upkeep, чтобы посмотреть журнал.",
		loginComment: "Проверять обновления приложений при входе и оставаться в трее",
		selfReady: "Upkeep {version} готов к установке",
		waitsMetered: "Автоматические обновления ждут безлимитного подключения.",
		waitsBattery: "Автоматические обновления ждут питания от сети.",
	},
	ja: {
		open: "Upkeep を開く",
		check: "今すぐ確認",
		installReady: { other: "準備済みの # 件をインストール" },
		systemUpdates: "システムの更新",
		quitAfterRun: "この実行の後に終了",
		quit: "終了",
		titleReady: { other: "Upkeep、# 件の更新の準備ができました" },
		more: { other: "ほか # 件" },
		readyCount: { other: "# 件の更新" },
		ready: "準備完了",
		updated: "更新しました",
		failed: "{name} を更新できませんでした。ログは Upkeep で確認できます。",
		loginComment: "ログイン時にアプリの更新を確認し、トレイに常駐します",
		selfReady: "Upkeep {version} の準備ができました",
		waitsMetered: "自動更新は従量制でない接続を待っています。",
		waitsBattery: "自動更新は AC 電源を待っています。",
	},
} satisfies Record<LanguageCode, TrayText>;

/** The wording a count takes in a language: the form for its plural category, else `other`, with `#` as the number. */
export function count(n: number, forms: Forms, code: LanguageCode): string {
	const category = new Intl.PluralRules(code).select(n);
	return (forms[category] ?? forms.other).replace("#", String(n));
}
