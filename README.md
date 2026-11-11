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

In that mode Upkeep checks, installs the apps marked `auto`, and waits. It sends one notification per new set of pending updates. No app is `auto` until you make it so: nothing in the list that ships with Upkeep is, and an app you add is not. Turn it on per app in its pane, or with `auto = true` in its table.

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

## Adding an app

Press **Add app** in the window. There are four ways in:

- **Paste** a GitHub `owner/repo` or any github.com link to the project. Upkeep reads the latest release, picks the asset that runs on this machine, works out the kind, and for an archive opens it to see which programs it holds (ripgrep ships `rg`, not `ripgrep`). If the app is already installed it finds it and reads its version.
- **Choose a file** or **drop a file** on the window. An AppImage that names its own release source is matched for certain. Otherwise Upkeep searches by name and marks the result as a guess to check.
- **Scan this computer.** It looks through `~/.local/bin`, `~/Applications` and `~/bin` for compiled programs and AppImages that are not in the list. It never runs what it finds. A guess is only offered when a well-known project has exactly that name and a release for this machine. Everything else is listed with "Could not tell where it comes from", and you paste the repo.

Each suggestion shows the name, the asset, where it will be installed, and one sentence on how it was worked out. You can change the name and the path before adding. An app that is not installed yet lands in Ready to install.

A program that the system's package manager owns (say `/usr/bin/rg` from apt) is left alone. Upkeep keeps its own copy in `~/.local/bin`, which comes first on the PATH.

**Remove from Upkeep** in an app's pane takes it off the list. It never uninstalls anything.

## The app list

`~/.config/upkeep/apps.toml`, copied from `manifest/apps.toml` on first run. Adding and removing in the window edits this file, one table at a time, and keeps the previous version as `apps.toml.bak`. You can also edit it by hand. One table per app:

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
| `~/.cache/upkeep/` | release lookups, downloads, source clones, the last check's rows. Safe to delete. |

## The old script

`legacy` and `manual` apps still go through `~/.local/bin/lutechi-updater`. Upkeep runs it with stand-ins for `zenity`, `notify-send` and `curl` first in its `PATH`, so its dialogs are answered, its progress bars become progress in the window, and its GitHub lookups use your `gh` token. Upkeep never edits that script, and it refuses to install anything while the script holds its own lock.

A `legacy` or `manual` app whose table carries `check` and `latest` is looked up by Upkeep itself, at the same time as the rest. The others wait for one run of the old script's `--check`, which takes 8 to 15 seconds here, and until it answers their rows show what the last check found.

## Build and install

```sh
bun run build
```

This writes `artifacts/linux-x64-Upkeep-Setup.tar.gz`. Unpack it and run `./installer`. It needs no root and puts the app under `~/.local/share/dev.afk.upkeep/stable/` with a menu entry. The launcher is `~/.local/share/dev.afk.upkeep/stable/app/bin/launcher`. To remove it, run `~/.local/share/dev.afk.upkeep/stable/uninstall --quiet`.

"Check at login" in Settings writes `~/.config/autostart/upkeep.desktop` and turning it off removes the file.

## The window

Upkeep draws its own title bar: the header is the drag area, a double click on it maximises, and the window buttons sit on the side the desktop uses (read from `org.cinnamon.desktop.wm.preferences button-layout`, then GNOME's key). Settings has three controls for it:

- **Window frame**: Built in, or System for the desktop's own title bar.
- **Window buttons**: Follow the desktop, Left or Right.
- **Window corners**: Rounded or Square. A rounded window is built see-through so its corners can be cut, and the desktop draws no shadow under a see-through window. Square keeps the shadow.

Changing the frame or the corners rebuilds the window, which takes a moment.

### System updates

The app list can also show the computer's own pending updates, the ones Linux Mint's Update Manager handles: Mint and Ubuntu packages (security, kernel and driver updates marked as such) and Flatpak apps and runtimes. They sit in a folded `System` group at the end of the list, with a button that opens Update Manager.

The group is off until you turn on **Show system updates** in Settings, under Extras. Upkeep only reads these lists. It installs none of them, because system packages need root and Update Manager already installs them with its own checks. For the same reason the tray number counts only Upkeep's own apps; the tray menu gets a separate "System updates" line instead.

## Develop

```sh
bun run validate     # format check, lint, types, unit tests, view build, browser specs
bun run dev:view     # the view alone at http://localhost:5182/?fixture
bun run e2e          # Playwright over the fixture
```

The identity (app icon, mark, wordmark, tray drawings) is in `assets/brand`. `bun run tray-icons` renders the tray pictures and the launcher icon from it.

`CLAUDE.md` has the rules for working in this repo. `PRODUCT.md` is the product record and `DESIGN.md` the visual system.
