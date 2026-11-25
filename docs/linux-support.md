# Which Linux

Upkeep is developed and used daily on Linux Mint 22 (Cinnamon, X11). Nothing in the engine names that system, and this is what each part needs:

| Part                                                                | Needs                                                                                                                                                                                                                   |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AppImage, archive, single-file and source apps, self-updating tools | any x86_64 or aarch64 (arm64) Linux; `gh` for a GitHub token is optional, and needed for a private repo                                                                                                                 |
| `.deb` apps                                                         | dpkg, so Debian, Ubuntu, Mint and their relatives                                                                                                                                                                       |
| `.rpm` apps                                                         | rpm on a system without dpkg, so Fedora, openSUSE, AlmaLinux and their relatives                                                                                                                                        |
| The window                                                          | WebKitGTK 4.1                                                                                                                                                                                                           |
| The tray                                                            | a StatusNotifierItem host; Upkeep carries its own libayatana-appindicator (`vendor/tray-libs`)                                                                                                                          |
| Window buttons on the desktop's side                                | Cinnamon's, GNOME's or KDE Plasma's (KWin's) settings; elsewhere they sit on the right, and Settings can move them                                                                                                      |
| Rounded corners                                                     | a compositing window manager                                                                                                                                                                                            |
| System group, Flatpak rows                                          | Flatpak                                                                                                                                                                                                                 |
| System group, package rows                                          | Linux Mint's Update Manager, apt, dnf, pacman or zypper                                                                                                                                                                 |
| Holding sleep during an install                                     | logind's `systemd-inhibit` and coreutils' `tail`; without them installs run as before, and the run log says so once. Closing the lid still suspends under logind's defaults                                             |
| Waiting for an unmetered connection and mains power                 | NetworkManager for metered and UPower for battery, both asked through `busctl`; without NetworkManager (systemd-networkd, ConnMan) the connection never counts as metered, and without UPower the power counts as mains |

## Supported

Upkeep supports the desktop distributions below and the ones built on them. Each was run on 2026-11-12 as a normal user: the window drew and ran a check, and the System group listed the updates the system's own tool showed, with installed and new versions.

| Distribution                      | Also covers                                | System updates read from                   |
| --------------------------------- | ------------------------------------------ | ------------------------------------------ |
| Linux Mint 22 (daily use)         |                                            | Update Manager                             |
| Ubuntu 26.04                      | Pop!_OS, Zorin OS, elementary OS, KDE neon | apt                                        |
| Debian 13                         | MX Linux                                   | apt                                        |
| Fedora 45                         | Nobara, Ultramarine                        | dnf                                        |
| Arch Linux                        | CachyOS, EndeavourOS, Manjaro              | pacman (`checkupdates`, else `pacman -Qu`) |
| openSUSE Tumbleweed and Leap 16.0 | Slowroll                                   | zypper                                     |
| Fedora Silverblue 45, Bazzite     | Kinoite, Aurora, Bluefin                   | Flatpak only (see below)                   |

Image-based systems (Fedora Silverblue and Bazzite, checked 2026-11-16 on real booted images in a VM): their `/usr` is read-only and changes only as a whole image, so Upkeep, which installs into your home folder, works as anywhere else. It sees the read-only `/usr` (`findmnt`), offers no `.deb` or `.rpm` there, and takes the same release's AppImage or archive instead, also for a catalogue app whose table names a package. The System group leaves out the package tool's list (dnf on Silverblue lists base packages it cannot install) and shows Flatpak. Neither system ships `libayatana-appindicator`, which Electrobun's native library needs before Upkeep can start; Upkeep carries its own copy (Ubuntu 24.04's, `vendor/tray-libs/NOTICE.md`). Stock GNOME, as on Silverblue, has no tray, so closing the window there quits Upkeep.

Not supported: NixOS, and musl systems such as Alpine. SteamOS has not been tried; its desktop mode is the same Plasma and Vapor theme as Bazzite's. Desktops checked: Cinnamon, GNOME 46 on Wayland and Xorg (Ubuntu 24.04), KDE Plasma 6.8 on Wayland (openSUSE Tumbleweed) and sway 1.9. The window is an X11 one, so on Wayland it runs through XWayland, which these desktops start on their own; a Wayland session with XWayland turned off cannot start Upkeep. Electrobun starts GTK before any of Upkeep's code runs, so Upkeep cannot say why there; the launch fails with GTK's "cannot open display". The tray needs a StatusNotifierItem host: Plasma, sway's bar and Cinnamon have one, GNOME through the AppIndicator extension that Ubuntu turns on. Not yet tried on a supported system: real arm64 hardware (the arm64 build was made and run under emulation, where the window drew and ran a check; the engine's choice of arm64 files is tested against real release lists).

A new list starts empty. Fill it with **Add app**: the catalogue's apps by name, anything else by its repo (GitHub, GitLab or Codeberg) or a file.
