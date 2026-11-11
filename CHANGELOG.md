# Changelog

## 0.1.0, unreleased

First version.

- One window lists every app with its installed and latest version, its size and its restore point. Tick what you want and press Install once. Nothing asks a question after that.
- Each app shows its own progress through download, back up, install and verify.
- A new version that will not start is replaced by the copy taken before it.
- Downloads are checked against the size and SHA-256 that GitHub lists.
- A running app is not closed. Its file is replaced and the row says "Restart to apply".
- An app built from source shows, in its pane, the commits it is behind by, newest first, and its row shows a Build stage while it builds.
- llama.cpp, Strata, ComfyUI, whisper.cpp, dsh and claude-code-telegram are updated by Upkeep itself, with restore points. Each builds while the running copy keeps serving, is swapped in only once the build passes, and is restarted and tested; anything that fails after the stop puts the old version back.
- `recover` from the command line finishes or undoes an update that was interrupted.
- Add an app by typing its name, pasting its GitHub repo, choosing or dropping a file, or scanning the computer. Remove one from its pane.
- A catalogue of 22 tested apps (AppImages, release binaries, .deb files, tools that update themselves, two built from source): typing one's name adds its known-good table.
- A new list starts empty and says so, with Add app right there.
- Filter the list by name.
- Skip one version of an app, hold an app, or mark it to install without asking.
- A tray icon shows how many updates are ready. One notification per new set of updates.
- "Start at login" in Settings opens Upkeep in the tray when you log in and checks for updates. Off until you turn it on.
- History of every install, and a log per run.
- The window draws its own title bar inside its header, with the window buttons on the side your desktop puts them. Settings can move them, square the corners, or hand the frame back to the desktop.
- The list opens with what the last check found and refreshes in place. On the first machine 28 of 32 apps report in under two seconds.
- "Restart to apply" stays on a row until the old copy of the app is no longer running.
- `check`, `install`, `restore` and `history` from the command line, through `bun run cli`.
- An optional, read-only System group lists the system's own pending updates without installing any: Flatpak apps and runtimes anywhere, and packages where Linux Mint's Update Manager is installed.
- Apps not yet ported run through the old `lutechi-updater` script with its dialogs answered for it.
