# Upkeep

A desktop updater for the apps the distro's package manager does not cover. Electrobun 2 (Bun main process, system webview), Svelte 5, TypeScript.

## Rules

- **The gate is `bun run validate`.** It formats-checks, lints with zero warnings, type-checks (`bun run check`), runs the unit tests, builds the view and runs the browser specs. Run it into a file and read the exit code. Never commit on a piped `tail`.
- **The engine imports nothing from `electrobun` and nothing from `src/mainview`.** It is plain TypeScript that the window and the command line both use. `src/shared/types.ts` is the only thing all three share.
- **Tests run in temp directories.** Every path the engine writes comes from `paths(env)`, and every process it starts goes through the runner in `deps`. A test that needs a real binary writes a script into its own temp dir. No test may call `sudo`, `dpkg`, `git clone` or the old updater.
- **This machine is the owner's daily driver.** Never run `upkeep install` or the old `lutechi-updater <app>` as a test. `check` is read-only. The old script at `~/.local/bin/lutechi-updater` is the engine for `legacy` apps and is never edited from this repo.
- **Copy is decided, not improvised.** Every string a person reads has a `data-testid` hook and the browser specs assert on it. Change the spec with the string.
- **Svelte 5 runes only.** No stores, no `$:`.
- **Git:** a feature branch and a pull request, never a commit to `main`. No AI attribution lines.

## Layout

```
manifest/apps.toml   the seed app list, copied to ~/.config/upkeep/apps.toml on first run
src/shared/          the contract between engine, main process and view
src/engine/          checks, downloads, installs, restore points, history
src/engine/kinds/    one file per way of installing an app
src/engine/shim/     stand-ins for zenity, notify-send and curl while the old script runs
src/bun/             the Electrobun main process: window, tray, RPC
src/mainview/        the Svelte view
src/cli.ts           upkeep check | install | restore | history
e2e/                 Playwright specs over the fixture
assets/tray/         tray pictures, rendered by scripts/tray-icons.ts
notes/               private working notes, gitignored
```

## Design

`PRODUCT.md` is the product record. `DESIGN.md` is the visual system as built. `.impeccable/surfaces/` holds the direction contract for the window. Read all three before touching the view.
