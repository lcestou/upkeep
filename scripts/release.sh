#!/bin/bash
# Prepares a release of Upkeep and prints the command that publishes it. It publishes nothing itself.
#
#   1. Set the new version in package.json, add its notes to CHANGELOG.md, merge that.
#   2. On main, clean:   bash scripts/release.sh
#   3. Read what it printed, then run the `gh release create` line yourself.
#
# It refuses a tree with changes, a version that is already released, and a build whose update address is not the
# repo's own. It runs the gate, builds, and runs the self-update trial (real builds of this source updating
# themselves in throwaway homes; about eleven minutes). An installed Upkeep reads its updates from the latest
# release, so the files attached to a release are what every install will take: this is the last look at them.
set -u
cd "$(dirname "$0")/.." || exit 1
die() {
	echo "release: $*" >&2
	exit 1
}
for tool in bun gh zstd tar python3; do command -v "$tool" >/dev/null || die "needs $tool"; done

# The trial's switches bake a local address or another version into a build. Never into a release.
[ -z "${UPKEEP_RELEASE_BASE_URL:-}" ] || die "UPKEEP_RELEASE_BASE_URL is set; that is for the trial only. Unset it."
[ -z "${UPKEEP_VERSION:-}" ] || die "UPKEEP_VERSION is set; that is for the trial only. Unset it."
[ -z "$(git status --porcelain)" ] || die "the tree has changes; commit or set them aside first"
[ "$(git branch --show-current)" = main ] || die "releases are cut from main"

VERSION=$(python3 -I -c 'import json;print(json.load(open("package.json"))["version"])')
TAG="v$VERSION"
echo "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || die "the version in package.json is '$VERSION'; a release is three numbers"
if gh release view "$TAG" >/dev/null 2>&1; then die "$TAG is already released; set the next version in package.json"; fi
LATEST=$(gh release view --json tagName --jq .tagName 2>/dev/null || true)
if [ -n "$LATEST" ]; then
	NEWER=$(printf '%s\n%s\n' "${LATEST#v}" "$VERSION" | sort -V | tail -1)
	[ "$NEWER" = "$VERSION" ] && [ "${LATEST#v}" != "$VERSION" ] || die "$VERSION is not newer than the latest release, $LATEST"
fi
grep -q "^## $VERSION" CHANGELOG.md || die "CHANGELOG.md has no section for $VERSION"

echo "release: the gate"
bun run validate >/tmp/upkeep-release-validate.log 2>&1 || die "the gate failed; see /tmp/upkeep-release-validate.log"

echo "release: the build"
bun run build >/tmp/upkeep-release-build.log 2>&1 || die "the build failed; see /tmp/upkeep-release-build.log"
ARCH=$(ls artifacts | sed -n 's/^stable-\(linux-[a-z0-9]*\)-update-v2\.json$/\1/p' | head -1)
[ -n "$ARCH" ] || die "the build wrote no update document"
ARCHIVE=$(ls artifacts/stable-"$ARCH"-*.tar.zst | head -1)
# What the build baked in: the version every install will compare, and the address every install will ask.
BAKED=$(zstd -dc "$ARCHIVE" | tar -xO --wildcards '*/Resources/version.json' 2>/dev/null)
WANT_URL=$(sed -n 's/^export const HOME = "\(.*\)";$/\1/p' src/bun/about.ts)/releases/latest/download
echo "$BAKED" | grep -q "\"version\":\"$VERSION\"" || die "the build is not version $VERSION: $BAKED"
echo "$BAKED" | grep -q "\"baseUrl\":\"$WANT_URL\"" || die "the build's update address is not $WANT_URL: $BAKED"
grep -q "\"version\":\"$VERSION\"" "artifacts/stable-$ARCH-update-v2.json" || die "the update document is not version $VERSION"

echo "release: the self-update trial"
bash scripts/self-update-trial/trial.sh >/tmp/upkeep-release-trial.log 2>&1 || die "the self-update trial failed; see /tmp/upkeep-release-trial.log"
# The trial builds its own versions; build the release again so artifacts/ holds the release and nothing else.
bun run build >/tmp/upkeep-release-build.log 2>&1 || die "the build failed; see /tmp/upkeep-release-build.log"

NOTES=/tmp/upkeep-release-notes-$VERSION.md
python3 -I - "$VERSION" >"$NOTES" <<'PY'
import re, sys
text = open("CHANGELOG.md").read()
m = re.search(rf"^## {re.escape(sys.argv[1])}[^\n]*\n(.*?)(?=^## |\Z)", text, flags=re.S | re.M)
print(m.group(1).strip() if m else "")
PY

echo
echo "Ready. Files for $TAG ($ARCH):"
ls -la artifacts | awk 'NR>1 && $9 !~ /^\.+$/ {printf "  %10s  %s\n", $5, $9}'
ls artifacts | grep -q '\.patch$' || echo "  (no patch: the previous release could not be read, so installs will download the full archive)"
echo "Notes: $NOTES"
echo
echo "An arm64 release needs the same build on an arm64 machine; attach its files to the same release."
echo "To publish, run:"
echo "  gh release create $TAG artifacts/* --title \"Upkeep $VERSION\" --notes-file $NOTES"
