# Changelog

## 0.1.0, unreleased

First version.

- One window lists every app with its installed and latest version, its size and its restore point. Tick what you want and press Install once. Nothing asks a question after that.
- Each app shows its own progress through download, back up, install and verify.
- A new version that will not start is replaced by the copy taken before it.
- Downloads are checked against the size and SHA-256 that GitHub lists.
- A running app is not closed. Its file is replaced and the row says "Restart to apply".
- Skip one version of an app, hold an app, or mark it to install without asking.
- A tray icon shows how many updates are ready. One notification per new set of updates.
- History of every install, and a log per run.
- `upkeep check`, `install`, `restore` and `history` from the command line.
- Apps not yet ported run through the old `lutechi-updater` script with its dialogs answered for it.
