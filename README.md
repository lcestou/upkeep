# Upkeep

One window for the apps the package manager misses. It checks every app in a list, shows what is pending with the old and new version, and installs what you tick with one press. Each app shows its own progress, nothing asks a question once the run starts, and the version that was replaced is kept so a bad update can be put back.

It covers AppImages, binaries from GitHub release archives, single-file binaries, .deb files, source builds, tools that update themselves, and apps you update by hand and only want tracked.

Linux first: built and tested on Linux Mint, and written to run on any x86_64 Linux desktop (see "Which Linux" below). Other operating systems are planned, not built. Built on [Electrobun](https://electrobun.dev) 2 with a Bun main process and a Svelte 5 view. The engine is plain TypeScript and also runs from the command line.

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
bun run cli recover               # finish or undo an update that was interrupted
```

`check` exits 0 unless the old updater's own check did not finish. `install` exits 0 when every app it ran ended updated.

## Adding an app

Press **Add app** in the window. There are five ways in:

- **Type an app's name**, such as `fd` or `Zen Browser`. Apps in Upkeep's catalogue come with a table that has been used for real: the asset pattern, where it installs, how to read its version. Upkeep still looks up today's release. A repo or link of a catalogue app finds the same table.
- **Paste** a GitHub `owner/repo` or any github.com link to the project. Upkeep reads the latest release, picks the asset that runs on this machine, works out the kind, and for an archive opens it to see which programs it holds (ripgrep ships `rg`, not `ripgrep`). If the app is already installed it finds it and reads its version.
- **Choose a file** or **drop a file** on the window. An AppImage that names its own release source is matched for certain. Otherwise Upkeep searches by name and marks the result as a guess to check.
- **Scan this computer.** It looks through `~/.local/bin`, `~/Applications` and `~/bin` for compiled programs and AppImages that are not in the list. It never runs what it finds. A guess is only offered when a well-known project has exactly that name and a release for this machine. Everything else is listed with "Could not tell where it comes from", and you paste the repo.

Each suggestion shows the name, the asset, where it will be installed, and one sentence on how it was worked out. You can change the name and the path before adding. An app that is not installed yet lands in Ready to install.

A program that the system's package manager owns (say `/usr/bin/rg` from apt) is left alone. Upkeep keeps its own copy in `~/.local/bin`, which comes first on the PATH.

**Remove from Upkeep** in an app's pane takes it off the list. It never uninstalls anything.

## The app list

`~/.config/upkeep/apps.toml`. On first run it is copied from `manifest/apps.toml`, which holds no apps, so a new list starts empty and fills from Add app. Adding and removing in the window edits this file, one table at a time, and keeps the previous version as `apps.toml.bak`. You can also edit it by hand. One table per app:

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
| `appimage` | one AppImage from a GitHub release, or from a vendor's update API that answers a version and a download (`latest = "json:<url>"`, https only in the catalogue) | `repo` or `latest`, `asset`, `dest` |
| `archive` | binaries inside a release `.tar.gz` or `.zip` | `repo`, `asset`, `dest`, `bins` |
| `file` | a binary that is itself the release asset | `repo`, `asset`, `dest` |
| `deb` | a `.deb` from a release, through `dpkg -i` | `repo`, `asset`, `dest` |
| `source` | a checkout or a clone of the release tag, built with your steps, restarted and tested | `build`, `check` or `dest`, `repo` or `latest` |
| `command` | a tool that updates itself | `check`, `latest`, `update`, and `restore` for a restore point |
| `claude-plugins` | every plugin in Claude Code's registry, through `claude plugin update` (versionless: it runs on Run now and in background runs when `auto` is set) | nothing beyond `name` |
| `legacy` | handed to the old `lutechi-updater` script | `legacy_key`, and `legacy_name` unless the table is `versionless` |
| `manual` | tracked only, you run the update | `legacy_name`, `run` |

Other fields: `version_args` (default `["--version"]`), `meta_path` (read an AppImage's version from a metainfo, `.desktop` or `.json` file inside it instead of running it), `sudo`, `process` (the process name to look for when deciding whether the app is running), `auto` (install without asking in background mode), `note`, `restart` (a command that restarts the app, such as `["systemctl", "restart", "rustdesk"]` for a service; `systemctl` asks for a password through the desktop's own prompt when it needs one) and `relaunch = true` (Upkeep may close the app and start `dest` again; it needs `process`, the name of the process it closes, which must be the app's own: the top processes with that name are asked to quit and their children go with them, so an interpreter's name such as `python` or `node` is refused).

`asset` is a regular expression matched against the release's asset names. If it matches more than one, the app is listed under "Needs a look" until you narrow it. Anchor it with `^` when a project ships several variants.

## Apps built from source

A `source` app with `dir` updates a checkout you already have, and one with only `stage` builds into that folder (dsh's table installs an npm prefix there); with neither, the release tag is cloned into the cache. The build runs while the live copy keeps serving. Only after it passes does Upkeep stop what must stop, swap the new build in, start it again, prove that a new process answers, and run the tests. When anything after the stop fails, the restore point goes back and the old version is started. If Upkeep itself is killed half way, `bun run cli recover` (or the next Install) finishes or undoes the update.

The short form, an app rebuilt in place:

```toml
[apps.whisper]
name = "whisper.cpp"
kind = "source"
repo = "ggml-org/whisper.cpp"
dir = "~/whisper.cpp"
move = "detach"
check = ["sh", "-c", '''git -C "$HOME/whisper.cpp" describe --tags --abbrev=0 | sed 's/^v//' ''']
keep = ["build"]
build = ["cmake --build build -j 6"]
test = [{ name = "whisper-cli starts", run = ["build/bin/whisper-cli", "--help"], timeout_s = 30 }]
```

`manifest/examples.toml` holds the long forms: llama.cpp builds into a stage beside the live copy and places one binary, Strata holds its running engine and writes config values, ComfyUI records its Python packages for an offline rollback, and dsh installs a second npm prefix and swaps it in.

| Field | What it does |
| --- | --- |
| `dir` | an existing git checkout, moved to the release tag in place |
| `move` | how `dir` moves: `ff` (fast-forward its branch, the default), `reset` (refused when HEAD is on no remote ref), `detach` |
| `check` | argv printing the installed version; its first line is taken as written |
| `commit` | argv printing the commit the installed copy was built from; the row is ready when the release is ahead of it on GitHub, and the pane lists the newest commits |
| `stage` | a directory the build writes into beside the live copy |
| `needs` | argv printing the directories the installed copy needs at run time; kept while a restore point names them |
| `prune` | globs of build directories that may go after a verified update, never one that is live or kept |
| `keep` | paths in `dir` saved in the restore point and put back by rename on a rollback; a link stays a link |
| `hold` | directories a running process executes from; moved aside and copied back so it keeps its open files; each must also be in `keep` |
| `record` | command output saved in the restore point as a file |
| `build` | shell steps run in `dir` (or the clone) |
| `check_built` | shell steps that must pass before anything is stopped |
| `config` | values written into JSON config files after the build: a top-level `key`, or the value after `flag` in an `array` |
| `place` | files or directories moved into place while services are stopped; the replaced one goes into the restore point |
| `undo` | shell steps run on a rollback after the files are back |
| `busy` | what must not be happening: a `process` name or a `run` that exits 0, with the sentence to `say`; `when = "stopped"` checks it only after `serve` has stopped |
| `pause` | units held off for the whole update, each only when it was running |
| `serve` | services stopped and started, each with `active`, `stop`, `start`, and optionally `since` (must change, proving a new process), `health`, `status`, `expect`, `wait_s` and its own `test` list |
| `test` | a command (`run`) or an HTTP POST (`url` and `body`) with `expect`, `fail_on`, `timeout_s` and `required` |

Steps and paths may use `{stage}`, `{tag}`, `{version}`, `{point}` and `{needs}`; any other name in braces is refused. A `command` app's `update` may use `{tag}` and `{version}`. A tag or version that is not a plain version name (letters, digits, `.`, `_`, `+`, `-`, starting with a letter or digit) is refused before anything runs. `latest` also takes `npm-tags:<package>`, the highest stable version at or above the installed one, else the highest prerelease. Every path a table removes, renames or copies over is checked where it is used: never the home directory, `dir` itself, or anything above them. `keep`, `hold` and `prune` must stay inside `dir`, also after following the links on the way there. A `place` target is never a folder directly in the home directory, nor Upkeep's own folders. A step that starts with `sudo` gets `-n`, so a password prompt never waits.

## The catalogue

`catalogue/` holds one file per app, `catalogue/<key>.toml`, each with the single `[apps.<key>]` table Add app writes when someone picks that app. To add an app, write its table the way it works on your machine, name the file after its key, and open a pull request; a unit test loads every file, so a broken one fails the gate. Apps built from source, which name a person's own folders and services, stay out of the catalogue: `manifest/examples.toml` shows them instead. No catalogue table sets `auto`.

## What an install does

1. **Download** to `~/.cache/upkeep/dl`. The size must equal what GitHub lists, and the SHA-256 must match the asset's digest when the release has one. A `json:` source lists neither: its download is trusted as the vendor's own answer, over https only, the way its own updater would trust it, and must be at least 1 MiB. The verify probe and the restore point catch a bad one.
2. **Back up** the files about to be replaced into `~/.local/share/upkeep/backups/<app>/<version>/`. This is the restore point. A `.deb` keeps the installed version's package, taken from that version's GitHub release, and goes back with `dpkg -i`. A self-updating app keeps one when its table has `restore`, a command with `{version}` (and `{tag}`) that installs a given version, such as `["bun", "add", "-g", "wrangler@{version}"]`. A source app with `dir` or `stage` keeps its checkout's commit, the files its table names and the files it replaces; one built in a fresh clone keeps none. "Restore points to keep" in Settings applies to all of them.
3. **Install.** The new file is written beside the old one and renamed into place, so a running copy keeps working and a full disk leaves the old file whole. A running app is not closed. Its row says "Restart to apply". When its table has `restart` or `relaunch`, its pane offers Restart now and the "Restart to finish" group a button that restarts every such app; one that would close a window asks first, since unsaved work in it is lost.
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

"Start at login" in Settings writes `~/.config/autostart/upkeep.desktop` and turning it off removes the file.

## The window

Upkeep draws its own title bar: the header is the drag area, a double click on it maximises, and the window buttons sit on the side the desktop uses (read from `org.cinnamon.desktop.wm.preferences button-layout`, then GNOME's key). Settings has three controls for it:

- **Window frame**: Built in, or System for the desktop's own title bar.
- **Window buttons**: Follow the desktop, Left or Right.
- **Window corners**: Rounded or Square. A rounded window is built see-through so its corners can be cut, and the desktop draws no shadow under a see-through window. Square keeps the shadow.

Changing the frame or the corners rebuilds the window, which takes a moment.

### System updates

The app list can also show the computer's own pending updates: Flatpak apps and runtimes on any system with Flatpak, and on Linux Mint the packages its Update Manager would install (security, kernel and driver updates marked as such). They sit in a folded `System` group at the end of the list. On Linux Mint its header has a button that opens Update Manager; on other systems the group says that package updates are listed on Linux Mint only, and shows the Flatpak ones.

The group is off until you turn on **Show system updates** in Settings, under Extras. Upkeep only reads these lists. It installs none of them, because system packages need root and Update Manager already installs them with its own checks. For the same reason the tray number counts only Upkeep's own apps; the tray menu gets a separate "System updates" line instead.

## Which Linux

Upkeep is developed on Linux Mint 22 (Cinnamon, X11) and has only been run there. Nothing in the engine names that system, and this is what each part needs:

| Part | Needs |
| --- | --- |
| AppImage, archive, single-file and source apps, self-updating tools | any x86_64 Linux; `gh` for a GitHub token is optional |
| `.deb` apps | dpkg, so Debian, Ubuntu, Mint and their relatives |
| The window | WebKitGTK 4.1 |
| Window buttons on the desktop's side | Cinnamon or GNOME settings; elsewhere they sit on the right, and Settings can move them |
| Rounded corners | a compositing window manager |
| System group, Flatpak rows | Flatpak |
| System group, package rows | Linux Mint's Update Manager (`mintupdate-cli`) |
| Apps of kind `legacy` | the first owner's own script; nothing in the catalogue or a new list uses it |

A new list starts empty. Fill it with **Add app**: the catalogue's apps by name, anything else by its GitHub repo or a file.

## Develop

```sh
bun run validate     # format check, lint, types, unit tests, view build, browser specs
bun run dev:view     # the view alone at http://localhost:5182/?fixture
bun run e2e          # Playwright over the fixture
```

The identity (app icon, mark, wordmark, tray drawings) is in `assets/brand`. `bun run tray-icons` renders the tray pictures and the launcher icon from it.

`PRODUCT.md` is the product record and `DESIGN.md` the visual system.
