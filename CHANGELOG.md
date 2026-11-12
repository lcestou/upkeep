# Changelog

## 0.1.0, unreleased

First version.

- Settings has Export and Import beside Open apps.toml, to carry the settings and app list to another computer as one file. The Language choice opens a list drawn inside the window, which no longer runs past its edge with scroll arrows and empty space.
- With nothing ready, the tray icon's plant is centred instead of leaving an empty space where the count badge goes.
- The command line can now do everything the window does: `list`, `add`, `remove`, and `export` and `import` of the settings and app list as one file to carry to another machine. Every command answers in JSON with `--json`, so a script or an agent can manage Upkeep without editing files.
- The window, the tray and the notifications come in ten languages: English, Chinese (Simplified), Spanish, Portuguese (Brazil), German, French, Italian, Polish, Russian and Japanese. Upkeep follows the desktop's language, or the one picked under **Language** in Settings, and switches at once. Counts use each language's own plural forms, and dates its own order.
- One window lists every app with its installed and latest version, its size and its restore point. Tick what you want and press Install once. Nothing asks a question after that.
- Each app shows its own progress through download, back up, install and verify.
- During a run, ticking a Ready app adds it to the end of the run, as a download manager would. The Installing group lists apps in the order they run, and an app's pane keeps its log on the newest line in a box of its own, so the pane no longer shifts as lines arrive.
- Deleting an old build or restore point no longer freezes the window: it is moved aside at once and deleted in the background. Checking whether an app is running no longer reads the memory of a process stuck on a closing AppImage, which could stall the window for minutes.
- A new version that will not start is replaced by the copy taken before it. .deb apps now keep the installed version's package as a restore point, and self-updating tools keep one when their table says how to install a given version (wrangler and claude-code-telegram in the catalogue do).
- Downloads are checked against the size and SHA-256 that GitHub lists.
- A running app is not closed. Its file is replaced and the row says "Restart to apply". An app whose table says how (a service's `systemctl restart`, or a desktop app Upkeep may close and reopen) can be restarted from its pane or from the "Restart to finish" group. Zen Browser and RustDesk in the catalogue can.
- An app built from source shows, in its pane, the commits it is behind by, newest first, and its row shows a Build stage while it builds.
- llama.cpp, Strata, ComfyUI, whisper.cpp, dsh and claude-code-telegram are updated by Upkeep itself, with restore points. Each builds while the running copy keeps serving, is swapped in only once the build passes, and is restarted and tested; anything that fails after the stop puts the old version back.
- `recover` from the command line finishes or undoes an update that was interrupted.
- Claude Code's plugins are one row that updates every installed plugin with `claude plugin update`, each in its own scope and project folder, and names the ones that failed. It never accepts a marketplace's command on the person's behalf. `versionless` now loads only on the old script's apps and this row; anywhere else it is refused with the reason, since such a row would fail every run.
- Add an app by typing its name, pasting its GitHub repo, choosing or dropping a file, or scanning the computer. Remove one from its pane.
- A catalogue of 23 tested apps (AppImages, release binaries, .deb files, tools that update themselves, two built from source): typing one's name adds its known-good table.
- An AppImage can come from a vendor's own update API instead of GitHub (`latest = "json:<url>"`, an answer with a version and a download), which is how Cursor ships; it is in the catalogue. A download whose size nobody listed must be at least 1 MiB, and the version can be read from a `.json` inside the image.
- Restart now closes a desktop app by its top process only, so an Electron app such as Cursor shuts down cleanly instead of its windows dying one by one.
- A new list starts empty and says so, with Add app right there.
- Filter the list by name.
- A table whose `latest` names a source Upkeep cannot read (anything but `npm:`, `pypi:`, `github:`, `npm-tags:` or `json:`) is refused when the list loads, with the reason, instead of failing at every check.
- Skip one version of an app, hold an app, or mark it to install without asking.
- A tray icon shows how many updates are ready. One notification per new set of updates.
- Upkeep checks on its own while it runs, in the window or the tray: every 6 hours by default, once a day, or only when you ask (Settings, Check for updates). A machine that slept through the time checks once when it wakes, and a clock that jumps never stops the schedule.
- "Start at login" in Settings opens Upkeep in the tray when you log in and checks for updates. Off until you turn it on.
- History of every install, and a log per run.
- The window draws its own title bar inside its header, with the window buttons on the side your desktop puts them. Settings can move them, square the corners, or hand the frame back to the desktop.
- The list opens with what the last check found and refreshes in place. On the first machine 28 of 32 apps report in under two seconds.
- "Restart to apply" stays on a row until the old copy of the app is no longer running.
- `check`, `install`, `restore` and `history` from the command line, through `bun run cli`.
- The window no longer comes up blank on openSUSE. The framework's launcher pointed `ICU_DATA` at a folder with no ICU data, which openSUSE's WebKit cannot start a page without; Upkeep clears it when the folder holds none.
- An optional, read-only System group lists the system's own pending updates without installing any: Flatpak apps and runtimes anywhere, and packages from Linux Mint's Update Manager, or else from apt, dnf, pacman or zypper. On Arch, a `checkupdates` that cannot run (it needs fakeroot) falls back to `pacman -Qu` instead of leaving the list empty.
- Every app is updated by Upkeep itself; the first owner's `lutechi-updater` script is no longer run. While its own login run holds its lock, Install waits.
