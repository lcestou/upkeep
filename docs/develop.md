# Develop

## Run it from a checkout

```sh
bun install
bun run dev          # build the view, start the window
```

The window opens, checks every app, and lists what it found. Closing the window hides it to the tray. Quit is in the tray menu.

To start in the tray with no window, the way a login entry does:

```sh
UPKEEP_BACKGROUND=1 bun run dev
```

In that mode Upkeep checks, installs the apps marked `auto`, and waits. It sends one notification per new set of pending updates. No app is `auto` until you make it so: nothing in the list that ships with Upkeep is, and an app you add is not. Turn it on per app in its pane, or with `auto = true` in its table.

## Build and install

```sh
bun run build
```

This writes `artifacts/linux-x64-Upkeep-Setup.tar.gz` on an x86_64 machine. The arm64 build of Upkeep is built the same way on an arm64 machine, and its file name names that platform instead. Unpack it and run `./installer`. It needs no root and puts the app under `~/.local/share/dev.afk.upkeep/stable/` with a menu entry. The launcher is `~/.local/share/dev.afk.upkeep/stable/app/bin/launcher`. To remove it, run `~/.local/share/dev.afk.upkeep/stable/uninstall --quiet`.

"Start at login" in Settings writes `~/.config/autostart/upkeep.desktop` and turning it off removes the file.

## Checks and tools

```sh
bun run validate     # format check, lint, types, unit tests, view build, browser specs
bun run dev:view     # the view alone at http://localhost:5182/?fixture
bun run e2e          # Playwright over the fixture
bun run i18n         # extract new strings into the catalogs in src/mainview/locales
bun run i18n:check   # fails when a catalog is stale or a string is untranslated (part of validate)
```

The window's text is translated with [wuchale](https://wuchale.dev): almost all of it lives in `src/mainview/lib/copy.ts`, as getters and functions so a language switch shows at once, and each language has a hand-written `.po` catalog. A new or changed string needs its translation in every catalog before the gate passes. The tray's words are a typed table in `src/bun/tray-text.ts`, since Vite never builds the Bun process. The engine writes its sentences through the templates in `src/shared/messages.ts`; the window reads a sentence back against them (`src/mainview/lib/engine-say.ts`) and words the same template from `engine-text.ts`, which the catalogs translate. A test holds the two English versions together, so a changed engine sentence needs its twin in `engine-text.ts` changed with it.

The identity (app icon, mark, wordmark, tray drawings) is in `assets/brand`. `bun run tray-icons` renders the tray pictures and the launcher icon from it.

`PRODUCT.md` is the product record and `DESIGN.md` the visual system.
