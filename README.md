# Upkeep

One window for the apps the package manager misses. It checks every app in a list, shows what is pending with the old and new version, and installs what you tick with one press. Each app shows its own progress, nothing asks a question once the run starts, and the version that was replaced is kept so a bad update can be put back.

It covers AppImages, binaries from GitHub release archives, single-file binaries, .deb files, source builds, tools that update themselves, and apps you update by hand and only want tracked.

Linux only for now. Built on [Electrobun](https://electrobun.dev) 2 with a Bun main process and a Svelte 5 view. The engine is plain TypeScript and also runs from the command line.

## Run it

```sh
bun install
bun run dev          # build the view, start the window
```

The window opens, checks every app, and lists what it found. Closing the window hides it to the tray. Quit is in the tray menu.

To start in the tray with no window, the way a login entry does:

```sh
UPKEEP_BACKGROUND=1 bun run dev
```

In that mode Upkeep checks, installs the apps marked `auto`, and waits. It sends one notification per new set of pending updates.

## Command line

```sh
bun run cli check                 # one line per app: OK, UPDATE, SKIP or BROKEN
bun run cli check --json          # the same as JSON, one app per line
bun run cli install fd zen        # install named apps
bun run cli install --all         # everything that is ready
bun run cli install --auto        # only apps marked auto
bun run cli restore fd            # put back the newest restore point
bun run cli history
```

`check` exits 0 unless the old updater's own check did not finish. `install` exits 0 when every app it ran ended updated.

## The app list

`~/.config/upkeep/apps.toml`, copied from `manifest/apps.toml` on first run and never rewritten after that. One table per app:

```toml
[apps.fd]
name = "fd"
kind = "archive"
repo = "sharkdp/fd"
asset = 'x86_64-unknown-linux-gnu\.tar\.gz$'
dest = "~/.local/bin/fd"
bins = ["fd"]
```

| Kind | What it installs | Needs |
| --- | --- | --- |
| `appimage` | one AppImage from a GitHub release | `repo`, `asset`, `dest` |
| `archive` | binaries inside a release `.tar.gz` or `.zip` | `repo`, `asset`, `dest`, `bins` |
| `file` | a binary that is itself the release asset | `repo`, `asset`, `dest` |
| `deb` | a `.deb` from a release, through `dpkg -i` | `repo`, `asset`, `dest` |
| `source` | a clone of the release tag, built with your steps | `repo`, `dest`, `build` |
| `command` | a tool that updates itself | `check`, `latest`, `update` |
| `legacy` | handed to the old `lutechi-updater` script | `legacy_key`, `legacy_name` |
| `manual` | tracked only, you run the update | `legacy_name`, `run` |

Other fields: `version_args` (default `["--version"]`), `meta_path` (read an AppImage's version from a metainfo or `.desktop` file inside it instead of running it), `sudo`, `process` (the process name to look for when deciding whether the app is running), `auto` (install without asking in background mode), `note`.

`asset` is a regular expression matched against the release's asset names. If it matches more than one, the app is listed under "Needs a look" until you narrow it. Anchor it with `^` when a project ships several variants.

## What an install does

1. **Download** to `~/.cache/upkeep/dl`. The size must equal what GitHub lists, and the SHA-256 must match the asset's digest when the release has one.
2. **Back up** the files about to be replaced into `~/.local/share/upkeep/backups/<app>/<version>/`. This is the restore point. `.deb`, source and self-updating apps have none.
3. **Install.** The new file is written beside the old one and renamed into place, so a running copy keeps working and a full disk leaves the old file whole. A running app is not closed. Its row says "Restart to apply".
4. **Verify.** The version probe runs again. If the new copy will not start, the restore point goes back and the row says so.

Root steps use `sudo -n`. If sudo wants a password the app fails with a message and nothing is changed.

## Where things live

| Path | Holds |
| --- | --- |
| `~/.config/upkeep/apps.toml` | the app list |
| `~/.local/state/upkeep/state.json` | skipped versions, held apps, settings |
| `~/.local/state/upkeep/logs/` | one log per run, the newest 50 |
| `~/.local/share/upkeep/history.jsonl` | every install, append-only |
| `~/.local/share/upkeep/backups/` | restore points |
| `~/.cache/upkeep/` | release lookups, downloads, source clones. Safe to delete. |

## The old script

`legacy` and `manual` apps still go through `~/.local/bin/lutechi-updater`. Upkeep runs it with stand-ins for `zenity`, `notify-send` and `curl` first in its `PATH`, so its dialogs are answered, its progress bars become progress in the window, and its GitHub lookups use your `gh` token. Upkeep never edits that script, and it refuses to install anything while the script holds its own lock.

## Build and install

```sh
bun run build
```

This writes `artifacts/linux-x64-Upkeep-Setup.tar.gz`. Unpack it and run `./installer`. It needs no root and puts the app under `~/.local/share/dev.afk.upkeep/stable/` with a menu entry. The launcher is `~/.local/share/dev.afk.upkeep/stable/app/bin/launcher`. To remove it, run `~/.local/share/dev.afk.upkeep/stable/uninstall --quiet`.

"Check at login" in Settings writes `~/.config/autostart/upkeep.desktop` and turning it off removes the file.

## Develop

```sh
bun run validate     # format check, lint, types, unit tests, view build, browser specs
bun run dev:view     # the view alone at http://localhost:5182/?fixture
bun run e2e          # Playwright over the fixture
```

`CLAUDE.md` has the rules for working in this repo. `PRODUCT.md` is the product record and `DESIGN.md` the visual system.
