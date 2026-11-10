# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Delegated by the owner on 2026-11-10 ("pick the best platform"). Electrobun 2 with a Bun main process and a Svelte 5 interface in the system webview, all TypeScript. A throwaway window on the owner's box (Linux Mint 22.3, X11, NVIDIA 580, two monitors at 2x) rendered sharp at 2x and held 30 animated rows at an 11 ms average frame with no frame over 34 ms.

## Users

One person today, the owner, on a Linux Mint Cinnamon desktop that is his daily driver. He keeps about 32 apps current that the distro's Update Manager does not cover. He opens the updater when its tray icon says something is pending, or right after login, and wants to be done in one decision.

Later, possibly, anyone on Linux, macOS or Windows who installs apps from GitHub releases. That audience is not confirmed and nothing is built for it yet beyond keeping the app list in a config file.

## Product Purpose

Keep the apps the package manager misses up to date. It checks every app, shows what is pending with the old and new version, lets the owner tick which ones to install, then installs them with no further questions and shows each one's progress. It keeps a copy of what it replaced so a bad update can be undone, and it keeps a log.

Success is the owner pressing Install once and walking away. Nothing is skipped because a prompt timed out, and when something fails he can see which app, why, and retry only that one.

## Positioning

The Linux Mint Update Manager, for everything it cannot see. One list covers AppImages, release binaries, .deb files from GitHub, source builds, tools that update themselves, and items the owner updates by hand.

## Operating Context

- It replaces `lutechi-updater`, a 2,332-line bash script that runs at login and asks about each app with its own dialog. Those dialogs close after 120 seconds and a missed one becomes a notification.
- It starts at login in the tray, checks quietly, and shows one count. The window opens when the owner asks for it.
- Updates can need root (`/usr/local/bin`, `dpkg -i`). On this box `sudo` needs no password.
- Some apps are running when their update arrives (the browser, the terminal, the editor). Some updates only take effect after a restart of the app or a service.
- GitHub allows 60 unauthenticated API calls an hour. One full check spends about 20.

## Capabilities and Constraints

- Kinds of app: AppImage, binary from a release archive, single-file binary, .deb, source build, self-updating tool, plugin set, notify-only.
- The old script stays installed and is the engine for the kinds not yet ported.
- The owner's commands `lutechi-updater --check`, `--list` and `lutechi-updater <app>` must keep working until he retires them.
- Apps are added in the window: paste a GitHub repo or link, choose or drop a file, or scan the computer. A scan never runs what it finds. Removing an app takes it off the list and uninstalls nothing.
- No prompt may appear after Install is pressed.
- This is a production machine. An update that cannot be verified is rolled back.
- Undecided: the product name (Upkeep is a working name), whether it is published, other operating systems.

## Evidence on Hand

- The current script at `~/.local/bin/lutechi-updater` and its log at `~/.local/share/lutechi-updater.log` (8,769 lines).
- A real pending list from 2026-11-10: fd 10.5.1 to 10.5.2, Zen Browser 1.24b to 1.24.1b, llama.cpp, Strata 0.2.10 to 0.2.13, ComfyUI 0.43.0 to 0.44.0, Cursor 3.29.9 to 3.29.15, wrangler 4.157.0 to 4.160.0.
- No users other than the owner, no testimonials, no benchmarks beyond the frame probe above.

## Product Principles

1. One decision. Everything the run needs to know is settled before Install is pressed.
2. Say what happened. Every state names the app, the version and the step, and a failure names its cause.
3. Never worse than before. Back up first, verify after, roll back on doubt.
4. Quiet by default. One tray count and one notification, never a dialog per app.
5. The list is the product. Versions and status are readable at a glance, and detail is one click away.

## Accessibility & Inclusion

Keyboard operable end to end. Status is never carried by colour alone. Motion respects the reduced-motion setting. The owner's displays are HiDPI at 2x.
