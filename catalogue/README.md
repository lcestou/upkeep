# The catalogue

Each file here is one app's table, named `<key>.toml`. [docs/catalogue.md](../docs/catalogue.md) explains how the gate checks a table and how to add one, and [docs/app-list.md](../docs/app-list.md) lists the fields.

## Where the tables came from

I wrote the first 130 or so by hand and installed each one for real in a test machine before it went in.

The rest started from other projects' lists of apps people install from GitHub:

- [aqua's registry](https://github.com/aquaproj/aqua-registry), command-line tools
- [mise's registry](https://github.com/jdx/mise), command-line tools
- [AppImageHub](https://github.com/AppImage/appimage.github.io), AppImages
- [AM](https://github.com/ivan-hc/AM), AppImages and portable apps

Upkeep took two facts per app from those lists, the project's name and how many stars it has. A script then ran Upkeep's own Add app code against each project's latest release to write the table. The gate checked every one, and I installed a sample in the test machine. No file from those projects is copied here.

`probe = false` comes from AM and aqua too. Neither runs a program to learn its version. They remember the one they installed, and Upkeep does the same for an app that opens a window or prints nothing useful when asked.

Thanks to all four.

## Fixing an app

If a table installs the wrong file or the wrong program, that's a bug. Open an issue with the app's name.
