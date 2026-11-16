# Contributing to Upkeep

Bug reports, catalogue apps and code are all welcome, from people and from AI coding agents alike. The rules below are the same for both.

## Report a bug

[Open an issue](../../issues) with:

- your distribution and desktop,
- what you did and what you expected,
- the row's message, and the log from **Show log** in the window (or the newest file in `~/.local/state/upkeep/logs/`).

For an app Upkeep reads wrong, its table from `~/.config/upkeep/apps.toml` helps most.

## Add an app to the catalogue

The catalogue is what Add app looks in first when someone types an app's name. Each app is one file, `catalogue/<key>.toml`, holding the single `[apps.<key>]` table that works on a real machine.

1. Add the app in your own Upkeep and install an update with it, so you know the table works.
2. Copy its table from `~/.config/upkeep/apps.toml` into `catalogue/<key>.toml`. Use paths under `~`, never your own home folder's name.
3. If the release has an arm64 build of the same kind, add `asset_aarch64` with the pattern that picks it.
4. Add the release's file names to `src/engine/fixtures/catalogue-assets.json` under the app's key, with the tag they came from. A test holds each `asset` pattern to exactly one of those names.
5. Raise the catalogue's counts by one: the total and the count for your app's kind in `src/engine/manifest.test.ts`, the arm64 count in `src/engine/catalogue.assets.test.ts` if you added `asset_aarch64`, and the three numbers in `README.md` (the badge, its alt text and "apps come ready-made"), and add your key to `catalogue/index.txt` in its sorted place.
6. Run `bun test src/engine/catalogue src/engine/manifest` and open a pull request.

A catalogue table runs on other people's machines, so `src/engine/catalogue.policy.test.ts` holds every table to a short list of fields and refuses commands that fetch and run code, delete folders or use `sudo` beyond `sudo make install`. A table never sets `auto`. Apps built from source name a person's own folders and services, so they stay out of the catalogue; [docs/source-builds.md](docs/source-builds.md) shows how to write one for yourself.

## Change the code

```sh
bun install
bun run dev              # build the view and start the window
bun run dev:view         # the view alone over demo data, at http://localhost:5182/?fixture
bun run validate:quick   # the checks, with only the browser specs you changed (about 40 s)
bun run validate         # everything, in Chromium and WebKit (about 2 min)
```

[docs/develop.md](docs/develop.md) has more on running and building. A pull request has to pass `bun run validate`, and these are the rules it checks or a reviewer will:

- **Never silence a rule to pass.** No `@ts-ignore`, no `any`, no disabled lint rule without its reason. A type assertion carries a `// SAFETY:` line that says why it holds.
- **The engine stands alone.** `src/engine` imports nothing from `electrobun` and nothing from `src/mainview`. The window and the command line both use it, and `src/shared` is all they share.
- **Tests run in temp directories.** Every path the engine writes comes from `paths(env)` and every process it starts goes through the runner in `deps`. No test may call `sudo`, `dpkg` or `git clone`.
- **Nothing is special-cased.** No app's name, path, service or port is written into `src/engine` or `src/bun`. What an app needs lives in its table, so every app runs through the same code.
- **Nothing is on by default.** No app installs without asking and no extra is on until the person turns it on.
- **Copy is decided, not improvised.** Every string a person reads has a `data-testid` and a browser spec that asserts it. A new or changed string needs its translation in all ten catalogs in `src/mainview/locales/`: run `bun run i18n`, fill each `msgstr`, and `bun run i18n:check` passes.
- **Svelte 5 runes only.** No stores, no `$:`.
- **Every function has a doc comment** that says what its name does not: the rule it carries and the case it gets wrong.
- **A change someone using Upkeep would notice gets a line in `CHANGELOG.md`** in the same pull request.

`PRODUCT.md` is the product record and `DESIGN.md` the visual system. Read both before changing the window.

## Releasing

An installed Upkeep takes its updates from the latest release, so a release is checked harder than a pull request. `bash scripts/release.sh`, on a clean `main` with the new version in `package.json` and its notes in `CHANGELOG.md`, runs the gate, builds, checks the version and the update address the build carries, and runs the self-update trial (`scripts/self-update-trial/trial.sh`): six real builds updating themselves in throwaway home folders, through every failure in [docs/updating-upkeep.md](docs/updating-upkeep.md). It then prints the command that publishes; it publishes nothing itself.

A change to `src/bun/self-*.ts`, to the start of `src/bun/index.ts` or to the login and menu entries runs the trial before it merges.

## Pull requests

One branch per change, named `type/YYYY-MM-DD-description`, and a pull request to `main`. Say what changed and why, and what you checked. Keep unrelated changes in separate pull requests.

By contributing you agree that your work is licensed under the GPL, version 3 or later, like the rest of Upkeep.
