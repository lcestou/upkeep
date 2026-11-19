# Apps built from source

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

A service that runs from inside a checkout is best started through a small script outside it that finds the files, so an upstream that moves its folders does not break the unit; the Strata example shows one. `manifest/examples.toml` holds the long forms: llama.cpp builds into a stage beside the live copy and places one binary, Strata holds its running engine and writes config values, ComfyUI records its Python packages for an offline rollback, and dsh installs a second npm prefix and swaps it in.

| Field         | What it does                                                                                                                                                                                   |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dir`         | an existing git checkout, moved to the release tag in place                                                                                                                                    |
| `move`        | how `dir` moves: `ff` (fast-forward its branch, the default), `reset` (refused when HEAD is neither in the release tag nor on a remote branch), `detach`                                      |
| `check`       | argv printing the installed version; its first line is taken as written                                                                                                                        |
| `commit`      | argv printing the commit the installed copy was built from; the row is ready when the release is ahead of it on GitHub, and the pane lists the newest commits                                  |
| `stage`       | a directory the build writes into beside the live copy                                                                                                                                         |
| `needs`       | argv printing the directories the installed copy needs at run time; kept while a restore point names them                                                                                      |
| `prune`       | globs of build directories that may go after a verified update, never one that is live or kept                                                                                                 |
| `keep`        | paths in `dir` saved in the restore point and put back by rename on a rollback; a link stays a link                                                                                            |
| `hold`        | directories a running process executes from; moved aside and copied back so it keeps its open files; each must also be in `keep`; one that is not there is skipped                             |
| `record`      | command output saved in the restore point as a file                                                                                                                                            |
| `build`       | shell steps run in `dir` (or the clone)                                                                                                                                                        |
| `check_built` | shell steps that must pass before anything is stopped                                                                                                                                          |
| `config`      | values written into JSON config files after the build: a top-level `key`, or the value after `flag` in an `array`; a `file` pattern that names no file fails the check                         |
| `place`       | files or directories moved into place while services are stopped; the replaced one goes into the restore point                                                                                 |
| `undo`        | shell steps run on a rollback after the files are back                                                                                                                                         |
| `busy`        | what must not be happening: a `process` name or a `run` that exits 0, with the sentence to `say`; `when = "stopped"` checks it only after `serve` has stopped                                  |
| `pause`       | units held off for the whole update, each only when it was running                                                                                                                             |
| `serve`       | services stopped and started, each with `active`, `stop`, `start`, and optionally `since` (must change, proving a new process), `health`, `status`, `expect`, `wait_s` and its own `test` list; the wait for `health` ends early when `since` moves again (the unit restarted on its own) or `active` fails twice in a row |
| `test`        | a command (`run`) or an HTTP POST (`url` and `body`) with `expect`, `fail_on`, `timeout_s` and `required`                                                                                      |

Steps and paths may use `{stage}`, `{tag}`, `{version}`, `{point}` and `{needs}`; any other name in braces is refused. A `command` app's `update` may use `{tag}` and `{version}`. A tag or version that is not a plain version name (letters, digits, `.`, `_`, `+`, `-`, starting with a letter or digit) is refused before anything runs. `latest` also takes `npm-tags:<package>`, the highest stable version at or above the installed one, else the highest prerelease. `crates:<crate>` reads crates.io's newest stable version, for a tool installed with `cargo install`. `text:<https URL>` takes the first line of the answer as the version, for a tool whose own updater reads such a file instead of the registry it is published on (Claude Code's `claude update` reads `https://downloads.claude.ai/claude-code-releases/latest`, which gets a release hours after npm). Every path a table removes, renames or copies over is checked where it is used: never the home directory, `dir` itself, or anything above them. `keep`, `hold` and `prune` must stay inside `dir`, also after following the links on the way there. A `place` target is never a folder directly in the home directory, nor Upkeep's own folders. A step that starts with `sudo` gets `-n`, so a password prompt never waits.
