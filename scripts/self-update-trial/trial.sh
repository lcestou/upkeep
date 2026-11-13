#!/bin/bash
# The self-update trial: real builds, a real install in a throwaway home, a hidden display, and every way an update
# of Upkeep itself can go wrong that we could think of. Each case ends on the same question: is an Upkeep that has
# started correctly installed, running, and holding the person's app list?
#
# Run it before a release, on a clean tree:   bash scripts/self-update-trial/trial.sh
# One case again, reusing the builds:         UPKEEP_TRIAL_DIR=/tmp/upkeep-trial.XXXX bash scripts/self-update-trial/trial.sh T8
#
# It needs Xvfb, dbus-run-session, xdotool, python3 and unshare, and port 8765 free on 127.0.0.1. It builds six
# versions (about five minutes), then runs the cases (about six). It never touches the real home: the installs, the
# homes and the logs are under its work folder, which it leaves in place for a look afterwards.
#
# In this checkout it changes three things. Each build replaces `artifacts/` and `build/`. And a faulty build is this
# same source with one line added near the top of src/bun/index.ts, taken out again when that build ends (and by the
# exit trap if the run is stopped): no test hook lives in the app. So start on a clean tree, and leave that file
# alone while this runs.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
PORT=8765

# ---------------------------------------------------------------------------------------------------------------
# One case, inside its own session bus: `trial.sh --case T1 <work>`
# ---------------------------------------------------------------------------------------------------------------
if [ "${1:-}" = "--case" ]; then
	CASE=$2
	WORK=$3
	export HOME=$WORK/homes/$CASE
	export XDG_DATA_HOME=$HOME/.local/share XDG_CONFIG_HOME=$HOME/.config XDG_STATE_HOME=$HOME/.local/state XDG_CACHE_HOME=$HOME/.cache
	# A socket path has a short limit: the work folder's own name is short, and so is this.
	export XDG_RUNTIME_DIR=$WORK/rt/$CASE
	export WEBKIT_DISABLE_COMPOSITING_MODE=1 LIBGL_ALWAYS_SOFTWARE=1 TAR_OPTIONS=--no-same-owner
	unset DBUS_SESSION_BUS_ADDRESS WAYLAND_DISPLAY XAUTHORITY SESSION_MANAGER UPKEEP_SELFTEST
	CH=$XDG_DATA_HOME/dev.afk.upkeep/stable
	LOG=$XDG_STATE_HOME/upkeep/self-update.log
	MENU=$XDG_DATA_HOME/applications/Upkeep.desktop
	FAILS=0
	mkdir -p "$HOME" "$XDG_RUNTIME_DIR" "$XDG_STATE_HOME/upkeep" "$XDG_CONFIG_HOME/upkeep" "$WORK/served-before"
	chmod 700 "$XDG_RUNTIME_DIR"

	# procs: pid and program of everything running from this case's home.
	procs() {
		local d e
		for d in /proc/[0-9]*; do
			e=$(readlink "$d/exe" 2>/dev/null) || continue
			case "$e" in "$HOME"/*) echo "${d#/proc/} ${e#"$CH"/}" ;; esac
		done
	}
	launcher_pid() { procs | awk '$2=="app/bin/launcher"{print $1}' | head -1; }
	has_launcher() { [ -n "$(launcher_pid)" ]; }
	one_launcher() { [ "$(procs | grep -c 'app/bin/launcher')" = 1 ]; }
	no_stage_procs() { ! procs | grep -q "app.prepared"; }
	ver() { sed -n 's/.*"version":"\([0-9.]*\)".*/\1/p' "$CH/app/Resources/version.json" 2>/dev/null; }
	is_ver() { [ "$(ver)" = "$1" ]; }
	hash_of() { sed -n 's/.*"hash":"\([a-z0-9]*\)".*/\1/p' "$1/Resources/version.json" 2>/dev/null; }
	offered_hash() { sed -n 's/.*"hash":"\([a-z0-9]*\)".*/\1/p' "$WORK/builds/$1/stable-linux-x64-update-v2.json"; }
	logged() { grep -q "$1" "$LOG" 2>/dev/null; }
	state_has() { tr -d ' \n\t' <"$XDG_STATE_HOME/upkeep/state.json" 2>/dev/null | grep -q "$1"; }
	window_shown() { xdotool search --onlyvisible --name '^Upkeep$' >/dev/null 2>&1; }
	# aside FILE...: moves files out of the way under a name of their own; nothing here deletes.
	aside() {
		local f
		for f in "$@"; do [ -e "$f" ] && mv "$f" "$WORK/served-before/$(basename "$f").$$.$RANDOM"; done
		return 0
	}
	# serve VARIANT [nopatch]: what the local release address offers.
	serve() {
		aside "$WORK"/serve/stable-* "$WORK/serve/.cut"
		cp "$WORK/builds/$1"/stable-* "$WORK/serve/"
		[ "${2:-}" = nopatch ] && aside "$WORK"/serve/*.patch
		return 0
	}
	# seed AUTO: a list of two apps, and the switch for automatic self-update, as a person would have set them.
	seed() {
		cat >"$XDG_CONFIG_HOME/upkeep/apps.toml" <<'TOML'
[apps.one]
name = "One"
kind = "manual"
check = ["sh", "-c", "echo 1.0.0"]
latest = "npm:left-pad"
run = "one-update"

[apps.two]
name = "Two"
kind = "manual"
check = ["sh", "-c", "echo 2.0.0"]
latest = "npm:left-pad"
run = "two-update"
TOML
		printf '{"settings":{"selfAuto":%s,"notify":false}}\n' "$1" >"$XDG_STATE_HOME/upkeep/state.json"
	}
	# install VARIANT: unpacks that build's installer and runs it; the installer starts Upkeep itself.
	install() {
		mkdir -p "$WORK/unpack/$CASE-$1" && tar -xzf "$WORK/builds/$1/linux-x64-Upkeep-Setup.tar.gz" -C "$WORK/unpack/$CASE-$1" &&
			(cd "$HOME" && UPKEEP_BACKGROUND=${BG:-1} "$WORK/unpack/$CASE-$1/installer" >"$HOME/installer.log" 2>&1)
		echo "  installer exit=$?"
	}
	# wait_for SECONDS COMMAND...: true as soon as the command is, false when the time is up.
	wait_for() {
		local end=$(($(date +%s) + $1))
		shift
		while [ "$(date +%s)" -lt "$end" ]; do
			if "$@" >/dev/null 2>&1; then return 0; fi
			sleep 0.3
		done
		return 1
	}
	expect() { if "$@" >/dev/null 2>&1; then echo "  ok: $*"; else
		echo "  FAIL: $*"
		FAILS=$((FAILS + 1))
	fi; }
	refute() { if "$@" >/dev/null 2>&1; then
		echo "  FAIL (should not hold): $*"
		FAILS=$((FAILS + 1))
	else echo "  ok, not: $*"; fi; }
	# healthy VERSION: the one check every case ends with.
	healthy() {
		local h
		h=$(hash_of "$CH/app")
		expect is_ver "$1"
		expect has_launcher
		expect test -e "$CH/.upkeep-ok-$h"
		expect test "$(grep -c '^\[apps\.' "$XDG_CONFIG_HOME/upkeep/apps.toml")" = 2
	}
	stop_all() {
		local p
		for p in $(procs | awk '{print $1}'); do kill "$p" 2>/dev/null; done
		sleep 1
	}
	# entry_exec FILE: an entry's Exec line with the desktop-entry escapes undone, as the session would run it.
	entry_exec() { sed -n 's/^Exec=//p' "$1" | head -1 | sed 's/%%/%/g; s/\\\\/\\/g'; }
	# start_entry [BG]: what a click on the menu entry runs, detached so it never holds this script's output.
	start_entry() { (cd "$HOME" && UPKEEP_BACKGROUND=${1:-1} setsid sh -c "$(entry_exec "$MENU")") >/dev/null 2>&1 </dev/null & }
	finish() {
		echo "  root: $(ls -A "$CH" 2>/dev/null | tr '\n' ' ')"
		tail -4 "$LOG" 2>/dev/null | cut -c1-180 | sed 's/^/    /'
		stop_all
		echo "$CASE FAILS=$FAILS"
		exit $((FAILS > 0))
	}

	case "$CASE" in
	T1) # A good update, applied by automatic mode with Upkeep in the tray.
		serve B && seed true && install A
		first=$(launcher_pid)
		wait_for 90 is_ver 0.1.1
		sleep 6
		healthy 0.1.1
		expect test "$(launcher_pid)" != "$first"
		refute test -e "$CH/app.keep"
		refute test -e "$CH/.upkeep-update.json"
		refute test -e "$CH/.upkeep-config-keep"
		expect grep -q '"key":"upkeep".*"result":"updated"' "$XDG_DATA_HOME/upkeep/history.jsonl"
		expect grep -q "upkeep-start.sh" "$MENU"
		# An update in the tray must not pop a window open.
		refute window_shown
		;;
	T2 | T3) # A new version that exits at once (T2) or hangs (T3) fails its start test; the running one is never touched.
		variant=$([ "$CASE" = T2 ] && echo Bexit || echo Bhang)
		serve "$variant" && seed true && install A
		first=$(launcher_pid)
		wait_for 100 logged "start test of 0.1.1 answered"
		sleep 2
		healthy 0.1.0
		expect test "$(launcher_pid)" = "$first"
		expect logged "start test of 0.1.1 answered null"
		refute logged "framework: applying"
		refute test -e "$CH/app.keep"
		refute test -e "$CH/.upkeep-update.json"
		expect state_has "\"selfFailed\":\"$(offered_hash "$variant")\""
		expect no_stage_procs
		expect test -z "$(ls "$XDG_CACHE_HOME/upkeep/tmp" 2>/dev/null)"
		refute test -e "$CH/app.prepared-$(offered_hash "$variant")"
		;;
	T4) # A corrupted archive.
		serve B nopatch
		python3 -I - "$WORK/serve/stable-linux-x64-Upkeep.tar.zst" <<'PY'
import sys
p = sys.argv[1]
b = bytearray(open(p, "rb").read())
b[len(b) // 2] ^= 0xFF
open(p, "wb").write(b)
PY
		seed true && install A
		first=$(launcher_pid)
		wait_for 90 logged "download failed"
		sleep 2
		healthy 0.1.0
		expect test "$(launcher_pid)" = "$first"
		expect logged "download failed"
		refute logged "start test of"
		refute logged "framework: applying"
		expect test -z "$(ls -d "$CH"/app.prep* 2>/dev/null)"
		;;
	T5) # The connection drops halfway through the archive; later the same address works and the update goes through.
		serve B nopatch && : >"$WORK/serve/.cut"
		seed true && install A
		first=$(launcher_pid)
		wait_for 90 logged "download failed"
		sleep 2
		healthy 0.1.0
		expect test "$(launcher_pid)" = "$first"
		refute logged "framework: applying"
		aside "$WORK/serve/.cut"
		# A failed download is not a failed build: the next start tries again.
		stop_all && start_entry
		wait_for 90 is_ver 0.1.1
		sleep 6
		healthy 0.1.1
		;;
	T6) # The address offers an older version than the one running.
		serve A && seed true && install B
		first=$(launcher_pid)
		wait_for 40 logged "update-available"
		sleep 6
		healthy 0.1.1
		expect test "$(launcher_pid)" = "$first"
		# The framework itself calls the older build an update; Upkeep does not take it.
		expect logged "update-available"
		refute logged "download-starting"
		;;
	T7) # Too little room: the install sits on a small file system of its own (this case runs in a user namespace).
		mkdir -p "$XDG_DATA_HOME/dev.afk.upkeep"
		mount -t tmpfs -o size=400m tmpfs "$XDG_DATA_HOME/dev.afk.upkeep" || {
			echo "  cannot mount a small file system here"
			FAILS=1
			finish
		}
		serve B && seed true && install A
		first=$(launcher_pid)
		wait_for 60 logged "Not enough free space"
		sleep 2
		healthy 0.1.0
		expect test "$(launcher_pid)" = "$first"
		expect logged "Not enough free space to update Upkeep"
		refute logged "download-starting"
		;;
	T8) # A new version that passes its start test and dies on a normal start: the menu entry puts the old one back.
		serve Blate && seed true && install A
		wait_for 90 is_ver 0.1.1
		sleep 4
		refute has_launcher
		expect test -d "$CH/app.keep"
		expect test -f "$CH/.upkeep-update.json"
		refute test -e "$CH/.upkeep-ok-$(hash_of "$CH/app")"
		# The new version rewrote the person's settings before it died.
		printf '{"settings":{"selfAuto":true,"notify":false,"keepBackups":5}}\n' >"$XDG_STATE_HOME/upkeep/state.json"
		start_entry
		wait_for 30 has_launcher
		sleep 5
		healthy 0.1.0
		expect test -d "$CH/app.failed"
		refute test -e "$CH/app.keep"
		refute test -e "$CH/.upkeep-update.json"
		refute test -e "$CH/.upkeep-rolled-back"
		expect grep -q '"key":"upkeep".*"result":"rolled_back"' "$XDG_DATA_HOME/upkeep/history.jsonl"
		# The settings are the ones the old version last wrote.
		refute state_has '"keepBackups":5'
		expect state_has '"selfAuto":true'
		expect state_has "\"selfFailed\":\"$(hash_of "$CH/app.failed")\""
		# The same build is still offered and is not tried again on its own.
		sleep 12
		expect is_ver 0.1.0
		;;
	T9) # The app folder is missing, as after a power cut between an update's two renames. Then the entries (T12).
		serve A && seed false && install A
		wait_for 30 has_launcher
		sleep 4
		expect grep -q "upkeep-start.sh" "$MENU"
		stop_all
		cat >"$CH/.upkeep-update.json" <<JSON
{
	"fromVersion": "0.1.0",
	"fromHash": "$(hash_of "$CH/app")",
	"toVersion": "0.1.1",
	"toHash": "neverarrived",
	"window": false,
	"startedAt": "2026-11-12T08:00:00.000Z"
}
JSON
		mv "$CH/app" "$CH/app.previous"
		start_entry
		wait_for 30 has_launcher
		sleep 5
		healthy 0.1.0
		refute test -e "$CH/app.previous"
		refute test -e "$CH/.upkeep-update.json"
		# A second click only shows the window of the Upkeep that runs.
		start_entry 0
		sleep 4
		expect one_launcher
		expect window_shown
		# With the start script gone, the entry still starts Upkeep, and the start puts the script back.
		stop_all
		mv "$CH/upkeep-start.sh" "$CH/upkeep-start.sh.gone"
		start_entry
		wait_for 30 has_launcher
		sleep 4
		healthy 0.1.0
		expect test -x "$CH/upkeep-start.sh"
		;;
	T10) # Two updates in a row: an install that updated itself can do it again.
		serve B && seed true && install A
		wait_for 90 is_ver 0.1.1
		sleep 6
		healthy 0.1.1
		serve C
		stop_all && start_entry
		wait_for 90 is_ver 0.1.2
		sleep 6
		healthy 0.1.2
		refute test -e "$CH/app.keep"
		expect test "$(grep -c '"key":"upkeep".*"result":"updated"' "$XDG_DATA_HOME/upkeep/history.jsonl")" = 2
		;;
	T11) # The window is open; the person presses Update Upkeep, then Restart now. The window is open again after.
		serve B && seed false && BG=0 install A
		wait_for 40 window_shown
		sleep 8
		eval "$(xdotool getwindowgeometry --shell "$(xdotool search --onlyvisible --name '^Upkeep$' | head -1)")"
		# The row's main button sits at the right end of the row under the header.
		xdotool mousemove --sync $((X + WIDTH - 77)) $((Y + 78)) click 1
		wait_for 60 logged "download-complete"
		sleep 6
		refute logged "framework: applying"
		first=$(launcher_pid)
		xdotool mousemove --sync $((X + WIDTH - 72)) $((Y + 78)) click 1
		wait_for 60 is_ver 0.1.1
		sleep 8
		healthy 0.1.1
		expect test "$(launcher_pid)" != "$first"
		expect window_shown
		;;
	T13) # The framework cannot start its helper (its temp folder is not writable): Upkeep stays up, as it was.
		mkdir -p "$HOME/ro-tmp" && chmod 555 "$HOME/ro-tmp"
		serve B && seed true
		TMPDIR="$HOME/ro-tmp" install A
		first=$(launcher_pid)
		wait_for 60 logged "framework: error"
		sleep 3
		healthy 0.1.0
		expect test "$(launcher_pid)" = "$first"
		expect logged "Failed to start update helper"
		refute test -e "$CH/app.keep"
		refute test -e "$CH/.upkeep-update.json"
		# Still the one Upkeep: a second start only asks it to show its window.
		start_entry 0
		sleep 5
		expect one_launcher
		expect window_shown
		;;
	*)
		echo "no such case: $CASE"
		exit 2
		;;
	esac
	finish
fi

# ---------------------------------------------------------------------------------------------------------------
# The runner
# ---------------------------------------------------------------------------------------------------------------
CASES=${*:-T1 T2 T3 T4 T5 T6 T7 T8 T9 T10 T11 T13}
for tool in Xvfb dbus-run-session xdotool python3 unshare bun; do
	command -v "$tool" >/dev/null || {
		echo "needs $tool"
		exit 2
	}
done
WORK=${UPKEEP_TRIAL_DIR:-$(mktemp -d /tmp/upkeep-trial.XXXXXX)}
mkdir -p "$WORK"/{builds,serve,homes,rt,logs,unpack}
echo "work folder: $WORK"
SERVER=""
XVFB=""
# shellcheck disable=SC2317 # called by the trap
stop_helpers() {
	[ -n "$SERVER" ] && kill "$SERVER" 2>/dev/null
	[ -n "$XVFB" ] && kill "$XVFB" 2>/dev/null
	# A run stopped in the middle of a faulty build must not leave its line in the source.
	if grep -q "// TRIAL FAULT$" "$REPO/src/bun/index.ts" 2>/dev/null; then
		echo "taking the trial's line out of src/bun/index.ts"
		(cd "$REPO" && python3 -I -c 'p="src/bun/index.ts"; l=open(p).read().split("\n"); open(p,"w").write("\n".join(x for x in l if not x.endswith("// TRIAL FAULT")))')
	fi
}
trap stop_helpers EXIT

python3 -I "$HERE/server.py" "$WORK/serve" "$PORT" &
SERVER=$!
sleep 1
kill -0 "$SERVER" 2>/dev/null || {
	echo "port $PORT is taken; the builds have this address baked in"
	exit 2
}
DISPLAY_N=${UPKEEP_TRIAL_DISPLAY:-97}
# A display that is already someone's would put the trial's windows on their screen.
if [ -e "/tmp/.X$DISPLAY_N-lock" ]; then
	echo "display :$DISPLAY_N is in use; set UPKEEP_TRIAL_DISPLAY to a free number"
	exit 2
fi
Xvfb ":$DISPLAY_N" -screen 0 1280x800x24 -nolisten tcp >/dev/null 2>&1 &
XVFB=$!
export DISPLAY=":$DISPLAY_N"
sleep 1

if [ ! -f "$WORK/builds/C/linux-x64-Upkeep-Setup.tar.gz" ]; then
	cd "$REPO" || exit 1
	if [ -n "$(git status --porcelain)" ]; then
		echo "the tree has changes; the faulty builds edit src/bun/index.ts and put it back, so start clean"
		exit 2
	fi
	export UPKEEP_RELEASE_BASE_URL="http://127.0.0.1:$PORT"
	# unfault: takes a faulty build's line out again, by editing it back.
	unfault() {
		python3 -I - <<'PY'
p = "src/bun/index.ts"
lines = open(p).read().split("\n")
kept = [l for l in lines if not l.endswith("// TRIAL FAULT")]
if len(kept) != len(lines):
    open(p, "w").write("\n".join(kept))
PY
	}
	# build NAME VERSION [LINE]: LINE is added after the first statement of the main process for this build only.
	build() {
		if [ -n "${3:-}" ]; then
			python3 -I - "$3" <<'PY'
import sys
p = "src/bun/index.ts"
s = open(p).read()
a = "dropStrayIcuData();"
assert s.count(a) == 1
open(p, "w").write(s.replace(a, a + "\n" + sys.argv[1] + " // TRIAL FAULT"))
PY
		fi
		UPKEEP_VERSION=$2 bun run build >"$WORK/logs/build-$1.log" 2>&1
		local code=$?
		unfault
		mkdir -p "$WORK/builds/$1" && cp artifacts/* "$WORK/builds/$1/"
		echo "built $1 ($2) exit=$code"
		[ $code = 0 ] || exit 1
	}
	# Nothing is served while A builds, so A has no patch; A is then served so the next builds can make theirs.
	build A 0.1.0
	cp "$WORK"/builds/A/stable-* "$WORK/serve/"
	build B 0.1.1
	build Bexit 0.1.1 'process.exit(3);'
	build Bhang 0.1.1 'await new Promise<never>(() => setInterval(() => {}, 1000));'
	build Blate 0.1.1 'if (!process.env.UPKEEP_SELFTEST) process.exit(3);'
	cp "$WORK"/builds/B/stable-* "$WORK/serve/"
	build C 0.1.2
	unset UPKEEP_RELEASE_BASE_URL
fi

failed=""
for c in $CASES; do
	echo "== $c"
	# T7 needs its own mount namespace for the small file system.
	wrap=()
	[ "$c" = T7 ] && wrap=(unshare -r -m)
	if timeout 600 dbus-run-session -- "${wrap[@]}" bash "$0" --case "$c" "$WORK" >"$WORK/logs/$c.log" 2>&1; then
		echo "   pass"
	else
		echo "   FAIL (see $WORK/logs/$c.log)"
		grep -E "FAIL|no such case" "$WORK/logs/$c.log" | head -8
		failed="$failed $c"
	fi
done
echo
if [ -n "$failed" ]; then
	echo "self-update trial: FAILED:$failed"
	exit 1
fi
echo "self-update trial: every case passed"
