# Tray libraries

Upkeep carries these libraries so that it starts on systems that ship no `libayatana-appindicator3` (Fedora Workstation, Silverblue, Bazzite). Electrobun's native library links it by name, and the launcher loads that library before any of Upkeep's own code runs. A build puts them beside the launcher (`scripts/post-build.ts`), whose library path is its own `bin` folder, so they are used on every system.

They are Ubuntu 24.04 (noble) binaries, unchanged, for x86_64 (`linux-x64`) and aarch64 (`linux-arm64`). `scripts/tray-libs.sh` fetches them and checks each against Ubuntu's signed archive index.

| File | Ubuntu package and version | Licence |
| --- | --- | --- |
| `libayatana-appindicator3.so.1` | libayatana-appindicator3-1 0.5.93-1build3 | GPL-3 or LGPL-2.1 or LGPL-3 |
| `libayatana-indicator3.so.7` | libayatana-indicator3-7 0.9.4-1build1 | GPL-3 |
| `libayatana-ido3-0.4.so.0` | libayatana-ido3-0.4-0 0.10.1-1build2 | GPL-3 or LGPL-2.1 or LGPL-3 |
| `libdbusmenu-glib.so.4` | libdbusmenu-glib4 18.10.20180917~bzr492+repack1-3.1ubuntu5 | LGPL-2.1 or LGPL-3 |
| `libdbusmenu-gtk3.so.4` | libdbusmenu-gtk3-4 18.10.20180917~bzr492+repack1-3.1ubuntu5 | LGPL-2.1 or LGPL-3 |

Upkeep itself is GPL-3.0-or-later. The source of each library is the Ubuntu source package of the same name and version, from https://launchpad.net/ubuntu/+source/libayatana-appindicator, https://launchpad.net/ubuntu/+source/libayatana-indicator, https://launchpad.net/ubuntu/+source/ayatana-ido and https://launchpad.net/ubuntu/+source/libdbusmenu; upstream is https://github.com/AyatanaIndicators and https://launchpad.net/libdbusmenu.
