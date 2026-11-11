#!/bin/bash
# Switches the window frame and the corners in the real window and checks that each rebuilt window paints.
# No browser spec can see this: a rebuilt window once came up blank because it was handed the first window's channel.
# Needs an X session with xdotool and ImageMagick, and no Upkeep running. Ends on the settings it started with.
# usage: bash scripts/real-frame.sh   (after `bunx vite build`)
set -u
export DISPLAY="${DISPLAY:-:0}"
cd "$(dirname "$0")/.." || exit 1
if xdotool search --name '^Upkeep$' >/dev/null 2>&1; then
	echo "An Upkeep window is open. Quit it first (tray, Quit)."
	exit 2
fi
state="${XDG_STATE_HOME:-$HOME/.local/state}/upkeep/state.json"
frame=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('settings',{}).get('frame','own'))" "$state" 2>/dev/null || echo own)
other=$([ "$frame" = own ] && echo system || echo own)
out=$(mktemp -d)
# Each switch rebuilds the window, which must come back on Settings; the corner controls exist only with Upkeep's own frame.
python3 - "$frame" "$other" >"$out/steps.json" <<'PY'
import json, sys
frame, other = sys.argv[1], sys.argv[2]
click = lambda t, ms: {"js": f"document.querySelector('[data-testid=\"{t}\"]')?.click()", "waitMs": ms}
switches = [f"setting-frame-{other}", f"setting-frame-{frame}"]
if frame == "own":
    switches += ["setting-corners-square", "setting-corners-rounded"]
# A switch, then a quiet step for the capture: the next switch tears the window down the moment it starts.
steps = [{"waitMs": 3000}, click("tab-settings", 1200)]
for t in switches:
    steps += [click(t, 4500), {"waitMs": 2500}]
print(json.dumps(steps))
PY
(UPKEEP_DEV_SCRIPT="$out/steps.json" timeout 90 bunx electrobun dev >"$out/dev.log" 2>&1 &)
for _ in $(seq 1 60); do xdotool search --name '^Upkeep$' >/dev/null 2>&1 && break; sleep 0.5; done
fail=0
last=$(($(grep -o waitMs "$out/steps.json" | wc -l) - 1))
for i in $(seq 2 2 "$last"); do
	for _ in $(seq 1 160); do grep -q "\[dev-script\] step $i settled" "$out/dev.log" 2>/dev/null && break; sleep 0.25; done
	w=$(xdotool search --name '^Upkeep$' 2>/dev/null | tail -1)
	colours=$(import -window "$w" png:- 2>/dev/null | convert - -format '%k' info: 2>/dev/null || echo 0)
	# A blank window is one colour; a painted Settings sheet is thousands.
	if [ "${colours:-0}" -lt 200 ]; then echo "step $i: BLANK ($colours colours)"; fail=1; else echo "step $i: painted ($colours colours)"; fi
done
for p in $(pgrep -x launcher); do
	case "$(tr '\0' ' ' <"/proc/$p/cmdline")" in *"$PWD/build/dev-linux-x64"*) kill "$p" ;; esac
done
rm -rf "$out"
exit $fail
