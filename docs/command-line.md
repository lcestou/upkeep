# Command line

Settings has **Add the upkeep command**, off until you turn it on. It writes a small script to `~/.local/bin/upkeep` that runs the command line with the installed Upkeep's own Bun, and turning the switch off removes it. A file already called `upkeep` there that Upkeep did not write, or a link, is never changed or removed; the switch then does nothing. `~/.local/bin` is on the `PATH` of most desktops once it exists; if `upkeep` is not found, log out and in once, or add the folder to `PATH`. The script outlives Upkeep's own updates. After Upkeep is uninstalled it prints where Upkeep used to be and exits 127; delete the file then.

From a checkout of this repo, `bun run cli` takes the same commands as `upkeep`.

```sh
upkeep check                 # one line per app: OK, UPDATE, HELD, SKIP or BROKEN
upkeep check --json          # the same as JSON, one app per line
upkeep install fd zen        # install named apps
upkeep install --all         # everything that is ready
upkeep install --auto        # only apps marked auto
upkeep restore fd            # put back the newest restore point
upkeep history
upkeep recover               # finish or undo an update that was interrupted
upkeep list                  # the apps in apps.toml, without a check
upkeep add sharkdp/fd        # add an app: a catalogue name, a repo, a GitHub, GitLab or Codeberg link, or a file
upkeep remove fd             # take it off the list; the app itself stays installed
upkeep hold fd on            # hold its updates; "off" releases a hold, also one Upkeep put on a changed release
upkeep export upkeep.json    # settings and app list as one file (to stdout without a name)
upkeep import upkeep.json    # replace them from such a file; add --yes when its apps run commands
```

With Settings' **Wait for an unmetered connection and mains power for automatic app updates** on, `install --auto` installs nothing while NetworkManager says the connection is metered or UPower says the machine is on battery: it prints `Automatic updates wait: the connection is metered.` (or `on battery.`) and exits 0; nothing retries it, so run it again later from your own timer. In the window and the tray, Upkeep tries the waiting apps again after each scheduled check until they install. `--json` prints `{"started": false, "wait": "metered", "reason": …}`. Installing named apps or `--all` never waits.

During `upkeep install`, the first Ctrl-C (or SIGTERM, or closing the terminal, which sends SIGHUP) is Stop now: Upkeep prints "Stopping: putting fd back. Press Ctrl-C again to quit at once, which can leave fd half-installed.", puts the app back as the window's Stop now does, and the apps behind it do not start. A step it must wait out prints what it waits for. A second Ctrl-C quits without putting the app back: it ends the step in progress (TERM, then KILL five seconds later) and exits. A step that runs as root (`sudo dpkg -i`, `sudo make install`) cannot be ended from there, so it keeps running, and Upkeep says so; run `upkeep recover` once it has finished. Ctrl-C during the check before an install quits at once, since nothing has changed yet. If the install starts by finishing or undoing an earlier interrupted update, a Ctrl-C then waits for that to end and installs nothing; a second one quits in the middle of it, and `upkeep recover` takes it up again.

`check` exits 0; an app it could not check is a SKIP line, not a failure. `install` exits 0 when every app it ran ended updated. Every other command exits 0 when it did what was asked and 1 when it did not, and prints why.

## For scripts and agents

Every command takes `--json` and then prints one JSON value per line instead of text: `check` and `list` an app each, `install` each engine event, `history` each run, `export` the document itself on one line (or, writing a file, `{"ok", "file"}`), and `add`, `remove`, `hold`, `restore`, `recover` and `import` one answer object. A `HELD` line from `check` ends with the reason when Upkeep held the app itself, and each `history` line of an update ends with how its download was checked. An agent can manage Upkeep with these alone and never has to edit a file:

- `add` writes only a sure match: a catalogue app by its name, a repo, a link, or a file that names its source. A file whose repo could only be guessed from its name is named in the answer (`candidate`) and not added; add that repo by name instead.
- `export` writes one file: `{"upkeep": 1, "exportedAt", "apps", "settings", "skip", "hold", "auto", "extras"}`, where `apps` is `apps.toml` as written, comments included, and `upkeep` is the format's version. Restore points, history and run state stay on the machine.
- `import` reads the whole file before it writes anything. It refuses a file of another format version and a list with any table that does not load, and refuses while an install runs. It keeps each file it replaces beside it as `<file>.pre-import-<time>`, and if a write fails midway it puts them back and removes any file the import created, or names each file it could not put back and where its copy is. Skips and holds are kept only for apps the new list has, and a pre-release switch is never taken from the file (an app whose table matches the one here keeps this machine's); a setting out of range reads as its default. A list with any app whose table makes Upkeep run a command or act for it (`check`, `update`, `restore`, `restart`, `relaunch`, a source build's steps, git moves of its `dir`, services, tests and HTTP checks, its `place` and `config` writes, any install as root: every `deb` and `rpm` and any table with `sudo`, and `version_args` other than one plain token such as `["version"]` on a `dest` under home) writes nothing without `--yes`: it prints each such app with where its code comes from and every command it runs, and exits 1, or under `--json` answers `{"ok": false, "ask": {"apps": [{"key", "name", "commands"}], "plain", "turnsOn", "turnsOff"}}`, where `plain` counts the apps that only install their release files, without root. A file that turns on a setting or extra that is off here (Notify, Start at login, Update Upkeep automatically, the upkeep command, Show system updates and installing them, Cleanup and its developer caches) asks the same way, listing each one (`"turnsOn"` under `--json`). So does a file that turns off **Wait for an unmetered connection and mains power for automatic app updates** where it is on here (`"turnsOff"`), since that lets automatic updates run. Turning anything else off, or changing a neutral choice (language, window frame, check interval, restore points to keep), does not ask. With `--yes` it prints the same list, then the result. Automatic installs come in off for every app that is not on this machine's list with the same table, release apps too, since a shared file chooses each app's repo; an app whose table matches the one here keeps this machine's pick, never the file's, so no import turns an automatic install on. The answer names those apps (`autoOff`); turn them on again per app. A list whose apps only install their release files, without root, imports in one step. The window asks the same question before it writes.

An open window reads `apps.toml` again at its next check, so a list changed from the command line shows there after Check again. `import` holds the run lock, so it never lands during an install; it can still race an app added in the window at the same moment, and the later write wins.

There is no network API on purpose: the command line already does everything the window does, and a listening socket that can install software would need an owner, a password and its own threat model.
