#!/bin/sh
# Installs Upkeep for the person running it: downloads the latest release's installer for this machine from GitHub
# and runs it. Upkeep goes under ~/.local/share/dev.afk.upkeep with an entry in the app menu, and updates itself from
# then on. No root: run it as yourself.
#
#   curl -fsSL https://raw.githubusercontent.com/lcestou/upkeep/main/install.sh | sh
set -eu

fail() {
	echo "Upkeep: $1" >&2
	exit 1
}

# All in one function called on the last line: piped into sh, the whole script is read before any of it runs, and the
# installer, reading /dev/null, cannot eat the rest of it.
main() {
	[ "$(uname -s)" = Linux ] || fail "Upkeep runs on Linux only."
	[ "$(id -u)" -ne 0 ] || fail "run this as yourself, not as root: Upkeep installs into your home folder."
	case "$(uname -m)" in
	x86_64 | amd64) arch=x64 ;;
	aarch64 | arm64) arch=arm64 ;;
	*) fail "Upkeep is built for x86_64 and aarch64; this machine is $(uname -m)." ;;
	esac

	url="https://github.com/lcestou/upkeep/releases/latest/download/linux-$arch-Upkeep-Setup.tar.gz"
	tmp=$(mktemp -d)
	trap 'rm -rf "$tmp"' EXIT
	# A signal ends the script, and the EXIT trap then cleans up.
	trap 'exit 1' INT TERM

	echo "Downloading $url"
	if command -v curl >/dev/null 2>&1; then
		curl -fL --progress-bar "$url" -o "$tmp/setup.tar.gz" || fail "the download failed."
	elif command -v wget >/dev/null 2>&1; then
		wget -q "$url" -O "$tmp/setup.tar.gz" || fail "the download failed."
	else
		fail "neither curl nor wget is installed."
	fi

	tar -xzf "$tmp/setup.tar.gz" -C "$tmp" || fail "the download is not a readable archive."
	[ -f "$tmp/installer" ] && [ -x "$tmp/installer" ] || fail "the archive holds no installer."
	(cd "$tmp" && ./installer </dev/null) || fail "the installer stopped. Its output is above."
	echo "Upkeep is installed. Open it from your app menu."
}

main "$@"
