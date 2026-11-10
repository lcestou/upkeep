# Changelog

## 0.1.0, unreleased

First version.

- One window lists every app with its installed and latest version, its size and its restore point. Tick what you want and press Install once. Nothing asks a question after that.
- Each app shows its own progress through download, back up, install and verify.
- A new version that will not start is replaced by the copy taken before it.
- Downloads are checked against the size and SHA-256 that GitHub lists.
- A running app is not closed. Its file is replaced and the row says "Restart to apply".
- Add an app by pasting its GitHub repo, choosing or dropping a file, or scanning the computer. Remove one from its pane.
- Filter the list by name.
- Skip one version of an app, hold an app, or mark it to install without asking.
- A tray icon shows how many updates are ready. One notification per new set of updates.
- History of every install, and a log per run.
- The window draws its own title bar inside its header, with the window buttons on the side your desktop puts them. Settings can move them, square the corners, or hand the frame back to the desktop.
- The list opens with what the last check found and refreshes in place. On the first machine 28 of 32 apps report in under two seconds.
- "Restart to apply" stays on a row until the old copy of the app is no longer running.
- `upkeep check`, `install`, `restore` and `history` from the command line.
- An optional, read-only System group lists what Update Manager would install, Mint packages and Flatpaks, without installing any of it.
- Apps not yet ported run through the old `lutechi-updater` script with its dialogs answered for it.
