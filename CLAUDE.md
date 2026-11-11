# Upkeep

A desktop updater for the apps the distro's package manager does not cover. Electrobun 2 (Bun main process, system webview), Svelte 5, TypeScript.

## Rules

- **The gate is `bun run validate`.** It formats-checks, lints with zero warnings, type-checks (`bun run check`), runs the unit tests, builds the view and runs the browser specs. Run it into a file and read the exit code. Never commit on a piped `tail`.
- **The engine imports nothing from `electrobun` and nothing from `src/mainview`.** It is plain TypeScript that the window and the command line both use. `src/shared/types.ts` is the only thing all three share.
- **Tests run in temp directories.** Every path the engine writes comes from `paths(env)`, and every process it starts goes through the runner in `deps`. A test that needs a real binary writes a script into its own temp dir. No test may call `sudo`, `dpkg`, `git clone` or the old updater.
- **This machine is the owner's daily driver.** Never run `upkeep install` or the old `lutechi-updater <app>` as a test. `check` is read-only. The old script at `~/.local/bin/lutechi-updater` is the engine for `legacy` apps and is never edited from this repo.
- **A change to how the window is built is checked in the real window.** `bash scripts/real-frame.sh` (after `bunx vite build`, with no Upkeep running) switches the frame and the corners and fails when a rebuilt window comes up blank. The browser specs cannot see the main process.
- **Copy is decided, not improvised.** Every string a person reads has a `data-testid` hook and the browser specs assert on it. Change the spec with the string.
- **Svelte 5 runes only.** No stores, no `$:`.
- **The person chooses, and nothing is special-cased in code.** No app's name, no path under a home directory, no unit name and no port appears in `src/engine` or `src/bun`: they live in an app's table in `manifest/apps.toml`, so a stranger's app runs through the same code as the first owner's. No app installs without asking and no extra is on until the person turns it on. `PRODUCT.md` principles 6 and 7.
- **Every function has a doc comment that says what its name does not.** The rule it carries and the case it gets wrong go there, where the next reader meets them.
- **A change someone using Upkeep would notice gets a `CHANGELOG.md` line in the same pull request.**
- **`notes/queue.md` changes in the same session that changes its facts.** It is the ranked list of what comes next. When an item ships, is closed or gets its plan, move its line then, not in a later sweep.
- **Public text never talks about cleaning up the writing.** Commit messages, pull request titles and bodies, branch names, changelog lines and docs say what changed and why, and nothing about how the prose was produced.

## Git

- A branch per change, named `type/YYYY-MM-DD-description`, and a pull request to `main`. Never a commit to `main`. No AI attribution lines anywhere.
- **Never open a pull request, merge or push without the owner saying so in the current session.** Commit to the branch and report.
- When the code is ready: the full gate, `pr-review <PR URL>` and a Haiku deep review, started together, once. Check every finding against the code before fixing it. Review again only when a push changed code. Squash-merge on the owner's word, then tidy so only `main` remains.
- Batch related work into one pull request. Split when the changes are unrelated or one is risky enough to want its own revert.

## Working on this machine

- A dev build will not start while the installed Upkeep is running: it is a single instance, and the second start only asks the first to show its window. Quit the installed one first (tray, Quit).
- Drive the real window with the dev-only script player: `bunx vite build`, then `UPKEEP_DEV_SCRIPT=<steps.json> bunx electrobun dev`, and capture with `import -window`. Faults that only showed there so far: the system webview reports a light colour scheme on a dark desktop, stale CSS subgrid tracks, a rebuilt window with a dead channel, pixel art stair-steps at 2x, long version strings cut on both sides.
- Stop a dev instance by pid: `pgrep -x launcher`, then match `/proc/<pid>/cmdline` against this repo's `build/` path. Never `pgrep -f` or `pkill -f`, which match the shell that runs them.
- One browser-spec run at a time. Two at once slow each other into timeouts. `UPKEEP_E2E_PORT=5186` when another copy holds 5182.
- Undo a mutation control by editing the line back. `git checkout <file>` also throws away the uncommitted work beside it.
- Workers build in their own worktrees, `../upkeep-engine` and `../upkeep-view`, each on its own branch, and the session merges their commits after running the gate itself.
- To put a new build in the owner's menu: `bun run build`, unpack `artifacts/linux-x64-Upkeep-Setup.tar.gz` in a scratch directory, run `./installer`, then delete the `~/Desktop/Upkeep.desktop` it writes. It needs no root. `~/.local/share/dev.afk.upkeep/stable/uninstall --quiet` removes it.
- The services this machine runs (local models, image generation) are never started, stopped or rebuilt by a test or a trial run. The first real update of an app is the owner's own press.

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
assets/brand/        the identity as drawn: app icon masters, mark, wordmark, lockups, tray drawings
assets/tray/         tray pictures, rendered from assets/brand by scripts/tray-icons.ts
assets/icon/         the launcher icon, rendered by the same script
notes/               private working notes, gitignored: queue.md (what comes next), design/ (plans), research/
```

## Design

`PRODUCT.md` is the product record. `DESIGN.md` is the visual system as built. `.impeccable/surfaces/` holds the direction contract for the window. Read all three before touching the view.
