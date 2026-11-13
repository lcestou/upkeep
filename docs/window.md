# The window

Upkeep draws its own title bar: the header is the drag area, a double click on it maximises, and the window buttons sit on the side the desktop uses (read from `org.cinnamon.desktop.wm.preferences button-layout`, then GNOME's key). Settings has three controls for it:

- **Window frame**: Built in, or System for the desktop's own title bar.
- **Window buttons**: Follow the desktop, Left or Right.
- **Window corners**: Rounded or Square. A rounded window is built see-through so its corners can be cut, and the desktop draws no shadow under a see-through window. Square keeps the shadow.

Changing the frame or the corners rebuilds the window, which takes a moment.

## About

**About** in Settings shows the version and three links: **What's new** opens the changelog, **Report a bug** opens a new issue with the version, the distribution and the desktop already filled in, and **Upkeep on GitHub** opens the repo. Nothing is sent anywhere: each opens a page in your browser.

## Moving to another computer

**Export** in Settings, beside Open apps.toml, saves the settings and the app list as one file in a folder you pick; **Import** replaces them from such a file and checks again. The command line does the same with `upkeep export` and `upkeep import` (see [For scripts and agents](command-line.md#for-scripts-and-agents)).

## Languages

The window, the tray menu and the notifications speak English, Chinese (Simplified), Spanish, Portuguese (Brazil), German, French, Italian, Polish, Russian and Japanese. **Language** in Settings follows the desktop's language by default (`LANGUAGE`, then `LC_ALL`, `LC_MESSAGES` and `LANG`), falling back to English, or can be set to any of the ten. The switch shows at once, with no restart. What the engine reports (a row's problem, why an install failed, what Add app found) is translated too; a tool's own output, such as a compiler's error line, and the run log stay as the tool printed them. Right-to-left languages are not offered yet.
