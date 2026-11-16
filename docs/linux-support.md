# Which Linux

Upkeep is developed and used daily on Linux Mint 22 (Cinnamon, X11). Nothing in the engine names that system, and this is what each part needs:

| Part                                                                | Needs                                                                                   |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| AppImage, archive, single-file and source apps, self-updating tools | any x86_64 or aarch64 (arm64) Linux; `gh` for a GitHub token is optional, and needed for a private repo |
| `.deb` apps                                                         | dpkg, so Debian, Ubuntu, Mint and their relatives                                       |
| `.rpm` apps                                                         | rpm on a system without dpkg, so Fedora, openSUSE, AlmaLinux and their relatives        |
| The window                                                          | WebKitGTK 4.1                                                                           |
| Window buttons on the desktop's side                                | Cinnamon or GNOME settings; elsewhere they sit on the right, and Settings can move them |
| Rounded corners                                                     | a compositing window manager                                                            |
| System group, Flatpak rows                                          | Flatpak                                                                                 |
| System group, package rows                                          | Linux Mint's Update Manager, apt, dnf, pacman or zypper                                 |

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

Not supported: immutable systems (SteamOS, Bazzite, Fedora Silverblue), NixOS, and musl systems such as Alpine. Not yet tried on a supported system: Wayland sessions, the tray on desktops other than Cinnamon, and real arm64 hardware (the arm64 build was made and run under emulation, where the window drew and ran a check; the engine's choice of arm64 files is tested against real release lists).

A new list starts empty. Fill it with **Add app**: the catalogue's apps by name, anything else by its repo (GitHub, GitLab or Codeberg) or a file.
