#!/bin/bash
# Fetches the tray libraries Upkeep carries for systems that lack them (Fedora Workstation, Silverblue, Bazzite):
# libayatana-appindicator3 and what it links, from Ubuntu 24.04's archive, for x64 and arm64. Electrobun's native
# library links libayatana-appindicator3.so.1 by name, so without it Upkeep does not start at all; scripts/post-build.ts
# puts these beside the launcher in every build. Run by hand when the versions below change; the files are committed.
#
# Every file is checked: the archive's signed InRelease against Ubuntu's keyring, the Packages index against InRelease,
# and each .deb against the Packages index. Needs gpgv, dpkg-deb, curl and Ubuntu's archive keyring.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=vendor/tray-libs
KEYRING=/usr/share/keyrings/ubuntu-archive-keyring.gpg
SUITE=noble
# package name, version, the library file it holds
PACKAGES=(
	"libayatana-appindicator3-1 0.5.93-1build3 libayatana-appindicator3.so.1"
	"libayatana-indicator3-7 0.9.4-1build1 libayatana-indicator3.so.7"
	"libayatana-ido3-0.4-0 0.10.1-1build2 libayatana-ido3-0.4.so.0"
	"libdbusmenu-glib4 18.10.20180917~bzr492+repack1-3.1ubuntu5 libdbusmenu-glib.so.4"
	"libdbusmenu-gtk3-4 18.10.20180917~bzr492+repack1-3.1ubuntu5 libdbusmenu-gtk3.so.4"
)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

for pair in "amd64 http://archive.ubuntu.com/ubuntu linux-x64" "arm64 http://ports.ubuntu.com/ubuntu-ports linux-arm64"; do
	read -r arch base dir <<<"$pair"
	curl -fsSL "$base/dists/$SUITE/InRelease" -o "$WORK/InRelease"
	gpgv --keyring "$KEYRING" --output "$WORK/Release" "$WORK/InRelease" 2>/dev/null
	index="main/binary-$arch/Packages.gz"
	want=$(awk -v f="$index" '/^SHA256:/{s=1;next} /^[A-Z]/{s=0} s && $3==f {print $1}' "$WORK/Release")
	curl -fsSL "$base/dists/$SUITE/$index" -o "$WORK/Packages.gz"
	echo "$want  $WORK/Packages.gz" | sha256sum -c --quiet
	gunzip -c "$WORK/Packages.gz" >"$WORK/Packages"
	mkdir -p "$OUT/$dir"
	for entry in "${PACKAGES[@]}"; do
		read -r pkg ver lib <<<"$entry"
		# The stanza for this package at this version: its file path and checksum.
		# The last stanza may have no blank line after it, so the end of the file closes one too. read fails on no
		# output, which set -e would end the script on before the message below.
		file="" sum=""
		read -r file sum < <(awk -v p="$pkg" -v v="$ver" '
			function done() { if (pk==p && vr==v) {print fn, sh; found=1; exit} pk=vr=fn=sh="" }
			/^Package:/{pk=$2} /^Version:/{vr=$2} /^Filename:/{fn=$2} /^SHA256:/{sh=$2}
			/^$/{ done() } END { if (!found) done() }' "$WORK/Packages") || true
		[ -n "${file:-}" ] || { echo "$pkg $ver not in $arch index" >&2; exit 1; }
		curl -fsSL "$base/$file" -o "$WORK/$pkg.deb"
		echo "$sum  $WORK/$pkg.deb" | sha256sum -c --quiet
		rm -rf "$WORK/x" && dpkg-deb -x "$WORK/$pkg.deb" "$WORK/x"
		cp -L "$(find "$WORK/x" -name "$lib" | head -1)" "$OUT/$dir/$lib"
	done
	echo "$dir: $(ls "$OUT/$dir" | wc -l) libraries"
done
