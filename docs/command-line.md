# Command line

```sh
bun run cli check                 # one line per app: OK, UPDATE, SKIP or BROKEN
bun run cli check --json          # the same as JSON, one app per line
bun run cli install fd zen        # install named apps
bun run cli install --all         # everything that is ready
bun run cli install --auto        # only apps marked auto
bun run cli restore fd            # put back the newest restore point
bun run cli history
bun run cli recover               # finish or undo an update that was interrupted
bun run cli list                  # the apps in apps.toml, without a check
bun run cli add sharkdp/fd        # add an app: a catalogue name, a repo, a GitHub, GitLab or Codeberg link, or a file
bun run cli remove fd             # take it off the list; the app itself stays installed
bun run cli export upkeep.json    # settings and app list as one file (to stdout without a name)
bun run cli import upkeep.json    # replace them from such a file
```

`check` exits 0; an app it could not check is a SKIP line, not a failure. `install` exits 0 when every app it ran ended updated. Every other command exits 0 when it did what was asked and 1 when it did not, and prints why.

## For scripts and agents

Every command takes `--json` and then prints one JSON value per line instead of text: `check` and `list` an app each, `install` each engine event, `history` each run, `export` the document itself on one line (or, writing a file, `{"ok", "file"}`), and `add`, `remove`, `restore`, `recover` and `import` one answer object. An agent can manage Upkeep with these alone and never has to edit a file:

- `add` writes only a sure match: a catalogue app by its name, a repo, a link, or a file that names its source. A file whose repo could only be guessed from its name is named in the answer (`candidate`) and not added; add that repo by name instead.
- `export` writes one file: `{"upkeep": 1, "exportedAt", "apps", "settings", "skip", "hold", "auto", "extras"}`, where `apps` is `apps.toml` as written, comments included, and `upkeep` is the format's version. Restore points, history and run state stay on the machine.
- `import` reads the whole file before it writes anything. It refuses a file of another format version and a list with any table that does not load, and refuses while an install runs. It keeps each file it replaces beside it as `<file>.pre-import-<time>`, and if a write fails midway it puts them back and removes any file the import created, or names each file it could not put back and where its copy is. Skips, holds and automatic installs are kept only for apps the new list has; a setting out of range reads as its default.

An open window reads `apps.toml` again at its next check, so a list changed from the command line shows there after Check again. `import` holds the run lock, so it never lands during an install; it can still race an app added in the window at the same moment, and the later write wins.

There is no network API on purpose: the command line already does everything the window does, and a listening socket that can install software would need an owner, a password and its own threat model.
