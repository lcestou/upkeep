# What an install does

1. **Download** to `~/.cache/upkeep/dl`. The size must equal what the release lists, and the SHA-256 must match the asset's digest when the release has one. A `zsync:` source lists the size its `.zsync` header gives, and no digest. A `json:` source, a GitLab release and a `links:` page list neither: such a download is trusted as the publisher's own answer, over https only, the way its own updater would trust it, and must be at least 1 MiB. The verify probe and the restore point catch a bad one.
2. **Back up** the files about to be replaced into `~/.local/share/upkeep/backups/<app>/<version>/`. This is the restore point. A `.deb` keeps the installed version's package, taken from that version's release (or its `links:` page), and goes back with `dpkg -i`; an `.rpm` does the same through `rpm -U --oldpackage`. A self-updating app keeps one when its table has `restore`, a command with `{version}` (and `{tag}`) that installs a given version, such as `["bun", "add", "-g", "wrangler@{version}"]`. A source app with `dir` or `stage` keeps its checkout's commit, the files its table names and the files it replaces; one built in a fresh clone keeps none. "Restore points to keep" in Settings applies to all of them.
3. **Install.** The new file is written beside the old one and renamed into place, so a running copy keeps working and a full disk leaves the old file whole. A running app is not closed. Its row says "Restart to apply". When its table has `restart` or `relaunch`, its pane offers Restart now and the "Restart to finish" group a button that restarts every such app; one that would close a window asks first, since unsaved work in it is lost.
4. **Verify.** The version probe runs again. If the new copy will not start, the restore point goes back and the row says so.

Root steps use `sudo -n`. If sudo wants a password the app fails with a message and nothing is changed.

## Where things live

| Path                                  | Holds                                                                             |
| ------------------------------------- | --------------------------------------------------------------------------------- |
| `~/.config/upkeep/apps.toml`          | the app list                                                                      |
| `~/.local/state/upkeep/state.json`    | skipped versions, held apps, settings                                             |
| `~/.local/state/upkeep/logs/`         | one log per run, the newest 50                                                    |
| `~/.local/share/upkeep/history.jsonl` | every install and cleanup, append-only                                            |
| `~/.local/share/upkeep/backups/`      | restore points                                                                    |
| `~/.cache/upkeep/`                    | release lookups, downloads, source clones, the last check's rows. Safe to delete. |
