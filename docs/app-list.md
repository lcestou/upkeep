# The app list

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

| Kind             | What it installs                                                                                                                                        | Needs                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `appimage`       | one AppImage from a release, or from a vendor's update API that answers a version and a download (`latest = "json:<url>"`, https only in the catalogue) | `repo` or `latest`, `asset`, `dest`                            |
| `archive`        | binaries inside a release `.tar.gz`, `.tar.xz`, `.tar.bz2`, `.tar.zst` or `.zip` (a `*` in a `bins` name stands for a version)                          | `repo` or `latest`, `asset`, `dest`, `bins`                    |
| `file`           | a binary that is itself the release asset                                                                                                               | `repo` or `latest`, `asset`, `dest`                            |
| `deb`            | a `.deb` from a release, through `dpkg -i`                                                                                                              | `repo` or `latest`, `asset`, `dest`                            |
| `rpm`            | a `.rpm` from a release, through `rpm -U --oldpackage`                                                                                                  | `repo` or `latest`, `asset`, `dest`                            |
| `source`         | a checkout or a clone of the release tag, built with your steps, restarted and tested                                                                   | `build`, `check` or `dest`, `repo` or `latest`                 |
| `command`        | a tool that updates itself                                                                                                                              | `check`, `latest`, `update`, and `restore` for a restore point |
| `claude-plugins` | every plugin in Claude Code's registry, through `claude plugin update`. Its check refreshes the marketplaces and turns the row ready, naming the plugins, when a marketplace holds a newer version (or, for a plugin with no version, new commits in its own folder); it also runs on Run now and in background runs when `auto` is set | nothing beyond `name`                                          |
| `manual`         | tracked only: checked like a self-updating tool, and you run the update                                                                                 | `check`, `latest`, `run`                                       |

Other fields: `version_args` (default `["--version"]`), `meta_path` (read an AppImage's version from a metainfo, `.desktop` or `.json` file inside it instead of running it), `probe = false` (never run the program to ask its version, for one that opens its window or names no version when asked: the version is the one Upkeep installed, kept while the file is unchanged, and a copy put there some other way is offered the latest so installing it makes the version known), `folder` (an archive whose program needs the files around it, such as a `lib/` folder: the whole archive unpacks into this folder under home, swapped in by rename, and each `bins` entry is a path inside it, linked from `dest`'s directory; a restore point keeps the whole folder), `sudo`, `process` (the process name to look for when deciding whether the app is running), `auto` (install without asking in background mode), `prerelease = true` (an AppImage, archive, file, `.deb` or `.rpm` with a `repo`: the check takes the highest version among the forge's ten newest releases that hold a file `asset` matches, pre-releases included, instead of the release the project marked latest; a repo that ships another product under the same releases is ranked by version too, so a precise `asset` keeps it out; a table of another kind, or without a `repo`, is refused when it loads; the switch Follow pre-releases in the app's pane sets the same thing for you and wins over the table), `note`, `restart` (a command that restarts the app, such as `["systemctl", "restart", "rustdesk"]` for a service; `systemctl` asks for a password through the desktop's own prompt when it needs one) and `relaunch = true` (Upkeep may close the app and start `dest` again; it needs `process`, the name of the process it closes, which must be the app's own: the top processes with that name are asked to quit and their children go with them, so an interpreter's name such as `python` or `node` is refused).

`repo` says where the releases are:

- `owner/name` is a GitHub repo, as every table before forges had it.
- `gitlab.com/group/name` is a GitLab project, with as many groups as it has (`gitlab.com/group/sub/name`). Its files are the release's links, each named by the file it points at.
- `codeberg.org/owner/name` is a Codeberg repo, read through the Gitea and Forgejo API.
- Any other host needs `forge = "gitlab"` or `forge = "gitea"` (Gitea and Forgejo), such as `repo = "git.example.org/me/tool"` with `forge = "gitea"`. Only such a repo may carry `forge`.

Upkeep's GitHub token goes to GitHub only. GitLab lists no size or checksum for a release file, so its download must be at least 1 MiB, as a `json:` one must; Gitea and Forgejo list the size. A source build clones from the same host. `commit` compares commits on GitHub only, so it needs a GitHub repo.

An `appimage`, `archive`, `file`, `deb` or `rpm` app whose project publishes no releases can read a plain download page instead: `latest = "links:https://example.org/downloads/"` in place of `repo`. Upkeep reads the page's links, resolves each against the page, matches `asset` against the file name each one points at, and takes the newest version a matching name holds (2.10 is newer than 2.9). Only https pages and links are read, and like a GitLab file each download must be at least 1 MiB. A `.deb` or `.rpm` keeps its restore point from the same page, when it still lists the installed version.

```toml
[apps.hello]
name = "GNU Hello"
kind = "archive"
latest = "links:https://ftp.gnu.org/gnu/hello/"
asset = '^hello-[0-9.]+\.tar\.gz$'
dest = "~/.local/bin/hello"
bins = ["hello"]
```

An AppImage that publishes a `.zsync` file at an address that never changes can be followed through it: `latest = "zsync:https://example.org/app/App-latest-x86_64.AppImage.zsync"` in place of `repo`. Upkeep reads only the file's header: `Filename` names the latest AppImage and holds its version, `URL` says where it is (resolved against the `.zsync` address) and `Length` is the size the download must have. `asset` is matched against `Filename`. Only `appimage` takes this source, since the address gives no older version to go back to; the restore point is the old file. Add app writes it for an AppImage whose update information is a `zsync|` address that is not a release file on GitHub, GitLab, Codeberg or a forge a table already names (a forge's package registry counts as such an address).

`asset` is a regular expression matched against the release's asset names. If it matches more than one, the app is listed under "Needs a look" until you narrow it. Anchor it with `^` when a project ships several variants.

`asset` is the pattern for an x86_64 machine. `asset_aarch64` is the same for an aarch64 (arm64) machine, and a table needs one of the two:

```toml
asset = 'x86_64-unknown-linux-gnu\.tar\.gz$'
asset_aarch64 = 'aarch64-unknown-linux-gnu\.tar\.gz$'
```

Upkeep reads the machine's architecture once at start and uses only that machine's pattern. An app added on an arm64 machine is written with `asset_aarch64`. A list moved to a machine of the other architecture (Export and Import) keeps its tables, and an app whose table has no pattern for that machine shows "The table for … names no release file for … machines." instead of installing another architecture's file. Add the missing pattern by hand to fix it.
