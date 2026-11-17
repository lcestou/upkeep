# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Electrobun 2 with a Bun main process and a Svelte 5 interface in the system webview, all TypeScript. A test window on Linux Mint 22.3 (X11, two monitors at 2x) rendered sharp at 2x and held 30 animated rows at an 11 ms average frame with no frame over 34 ms.

## Users

People on a Linux desktop who install apps the distro's package manager does not cover: AppImages, binaries from release pages, source builds, tools that carry their own updater. They open Upkeep when its tray icon says something is pending, or right after login, and want to be done in one decision.

macOS and Windows are planned, not built.

## Product Purpose

Keep the apps the package manager misses up to date. It checks every app, shows what is pending with the old and new version, lets the person tick which ones to install, then installs them with no further questions and shows each one's progress. It keeps a copy of what it replaced so a bad update can be undone, and it keeps a log.

Success is pressing Install once and walking away. Nothing is skipped because a prompt timed out, and when something fails the person can see which app, why, and retry only that one.

## Positioning

The update manager your desktop ships with, for everything it cannot see. One list covers AppImages, release binaries, .deb and .rpm files from a release page, source builds, tools that update themselves, and items updated by hand.

## Operating Context

- It starts at login in the tray, checks quietly, and shows one count. The window opens when asked for.
- Updates can need root (`/usr/local/bin`, `dpkg -i`). Root steps run through `sudo -n`: where sudo wants a password the app fails with a message and nothing is changed.
- Some apps are running when their update arrives (the browser, the terminal, the editor). Some updates only take effect after a restart of the app or a service.
- GitHub allows 60 unauthenticated API calls an hour. One full check spends about 20.

## Capabilities and Constraints

- Kinds of app: AppImage, binary from a release archive, single-file binary, .deb, .rpm, source build (a checkout updated in place, built beside the live copy, restarted and tested), self-updating tool, plugin set, notify-only.
- Apps are added in the window: paste a repo or link (GitHub, GitLab, Codeberg or a self-hosted forge), choose or drop a file, or scan the computer. A scan never runs what it finds. Removing an app takes it off the list and uninstalls nothing.
- Opt-in extras, each off until switched on in Settings: the system's own pending updates in the list, installable from Upkeep behind a second switch, and a Cleanup tab that deletes only what is ticked and reviewed.
- No prompt may appear after Install is pressed.
- People run this on the machine they work on. An update that cannot be verified is rolled back.
- Direction: any Linux first, then any operating system. Today it is built on Linux Mint; the window and tray were also checked on GNOME, KDE Plasma and sway, on Wayland through XWayland. What already works on any x86_64 or aarch64 Linux desktop with WebKitGTK: AppImages, release archives, single files, source builds, self-updating tools, the window and the tray. What is tied to one family today: `.deb` installs need dpkg; installing package rows from the System group needs Linux Mint's Update Manager or plain apt (Flatpak rows need only Flatpak; dnf, pacman and zypper rows are listed, not installed); the window buttons' side is read from Cinnamon's or GNOME's settings and falls back to the right. Nothing for macOS or Windows exists yet.

## Evidence on Hand

- Every table in `catalogue/` was installed in a clean container before it shipped.
- The unit tests run the engine in temp directories, and the browser specs run the window over a fixture in Chromium and WebKit.
- The arm64 build was made and run under emulation only, not on real hardware.
- No testimonials, and no benchmarks beyond the frame probe above.

## Product Principles

1. One decision. Everything the run needs to know is settled before Install is pressed.
2. Say what happened. Every state names the app, the version and the step, and a failure names its cause.
3. Never worse than before. Back up first, verify after, roll back on doubt.
4. Quiet by default. One tray count and one notification, never a dialog per app.
5. The list is the product. Versions and status are readable at a glance, and detail is one click away.

6. The person chooses. Upkeep offers the feature and the person turns it on: no app installs without asking until it is marked so, extras are off until switched on, and nothing about one machine's habits is a default for the next.
7. Nothing is special-cased in code. What an app needs in order to update (where it comes from, how it is built, what is stopped and started, how it is tested) is written in its entry in the app list, so every app is handled by the same code.

## Accessibility & Inclusion

Keyboard operable end to end. Status is never carried by colour alone. Motion respects the reduced-motion setting. Built and checked on HiDPI displays at 2x.
