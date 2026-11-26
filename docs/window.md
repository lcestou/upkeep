# The window

Upkeep draws its own title bar: the header is the drag area, a double click on it maximises, and the window buttons sit on the side the desktop uses (read from `org.cinnamon.desktop.wm.preferences button-layout`, then GNOME's key). Settings has three controls for it:

- **Window frame**: Built in, or System for the desktop's own title bar.
- **Window buttons**: Follow the desktop, Left or Right.
- **Window corners**: Rounded or Square. A rounded window is built see-through so its corners can be cut, and the desktop draws no shadow under a see-through window. Square keeps the shadow.

Changing the frame or the corners rebuilds the window, which takes a moment.

## Stopping a run

While a run installs, the footer shows **Stop after this one**: the app being installed runs to its end and the rest go back to ready. Once pressed, **Stop now** appears beside it. Stop now puts the app being installed back the way it was and ends the run there; the button reads "Stopping Zen Browser…" until it is done. A row whose step has printed nothing for two minutes says so ("No output for 3 min. It stops on its own in 7 min.") and carries its own Stop now. A stopped app reads Stopped, with what was put back, and History shows it as Stopped by you. What Stop now cuts and what it waits for is in [What an install does](how-an-install-works.md#stop-now).

## Release notes

An app's pane shows what changed in the release on offer. When the app comes from GitHub, GitLab or Codeberg releases and the installed version is more than one release behind, it shows the notes of every release after the installed one up to the latest, newest first, each under its version. Upkeep asks the forge for that list only when the pane opens, never during a check, and an unchanged list is read from its cache. The list holds the forge's ten newest releases and about 40,000 characters of notes; past either, the pane says that older releases are not shown, and the release page has them all. Source builds show their commits instead, and an app updated by its own command keeps the notes it showed before.

Above the notes, a **Breaking changes** line quotes up to three lines that read as a breaking change, each with the version it comes from. It is found by plain word rules, not by a model, so it can miss one or quote a harmless line; it only informs and never holds an update. A line counts when it holds any of these, in any case:

- "breaking" (as in "BREAKING CHANGE"), but not "non-breaking"
- "migrate", "migrates", "migrated", "migrating", "migration" or "migrations"
- "deprecated" and "removed" on the same line ("deprecated" alone only warns of a later removal)
- "incompatible" or "incompatibility"
- "requires manual" or "require manual"

A heading that matches, such as "## Breaking changes", is not quoted itself: the first line under it is. The list lives in `BREAKING_MARKERS` in `src/engine/notes.ts`.

## About

**About** in Settings shows the version and three links: **What's new** opens the changelog, **Report a bug** opens a new issue with the version, the distribution and the desktop already filled in, and **Upkeep on GitHub** opens the repo. Upkeep itself sends nothing: each opens a page in your browser, and the bug report's page carries the version and that one line about the system in its address.

## Moving to another computer

**Export** in Settings, beside Open apps.toml, saves the settings and the app list as one file in a folder you pick; **Import** replaces them from such a file and checks again. When the file has apps that run commands on this computer, Import first lists each one with where its code comes from and its exact commands, and writes nothing until you press Import there. It asks the same way, listing each one, when the file turns on a setting or extra that is off on this computer. Every app that is new to this computer, or whose table differs from the one here, comes in with automatic installs off. The command line does the same with `upkeep export` and `upkeep import` (see [For scripts and agents](command-line.md#for-scripts-and-agents)).

## Languages

The window, the tray menu and the notifications speak English, Chinese (Simplified), Spanish, Portuguese (Brazil), German, French, Italian, Polish, Russian and Japanese. **Language** in Settings follows the desktop's language by default (`LANGUAGE`, then `LC_ALL`, `LC_MESSAGES` and `LANG`), falling back to English, or can be set to any of the ten. The switch shows at once, with no restart. What the engine reports (a row's problem, why an install failed, what Add app found) is translated too; a tool's own output, such as a compiler's error line, and the run log stay as the tool printed them. Right-to-left languages are not offered yet.
