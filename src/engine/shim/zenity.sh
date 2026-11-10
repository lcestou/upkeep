#!/bin/bash
# Upkeep stands in for zenity so the old updater never waits on a dialog.
# Every dialog it answers is written to $UPKEEP_SHIM_EVENTS as one JSON line.
# Builtins only, so it works with any PATH.

events="${UPKEEP_SHIM_EVENTS:-/dev/null}"

json() {
	if command -v jq >/dev/null 2>&1; then
		printf '%s' "$1" | jq -Rs .
		return
	fi
	local s=${1//\\/\\\\}
	s=${s//\"/\\\"}
	s=${s//$'\n'/\\n}
	s=${s//$'\r'/\\r}
	s=${s//$'\t'/\\t}
	printf '"%s"' "$s"
}

emit() { printf '%s\n' "$1" >>"$events"; }

mode="" title="" text="" pulsate=0
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
	a=${args[i]}
	case "$a" in
	--title=*) title=${a#--title=} ;;
	--title) title=${args[i + 1]}; i=$((i + 1)) ;;
	--text=*) text=${a#--text=} ;;
	--text) text=${args[i + 1]}; i=$((i + 1)) ;;
	--pulsate) pulsate=1 ;;
	--question | --info | --warning | --error | --progress | --entry | --list | --notification | --forms | --scale | --calendar | --text-info | --password | --file-selection | --color-selection)
		[ -z "$mode" ] && mode=${a#--}
		;;
	esac
done

case "$mode" in
question)
	answer=true
	rc=0
	# The old script's "Launch now?" after an install (line 628): reopen only an app that was open before.
	if [ "$title" = "Installation Complete!" ] && [ "${UPKEEP_SHIM_RELAUNCH:-0}" != "1" ]; then
		answer=false
		rc=1
	fi
	emit "{\"dialog\":\"question\",\"title\":$(json "$title"),\"answer\":$answer}"
	exit $rc
	;;
progress)
	[ "$pulsate" = "1" ] && emit '{"pct":null}'
	# Read to the end so the writer never gets SIGPIPE.
	while IFS= read -r line || [ -n "$line" ]; do
		if [[ "$line" =~ ^[0-9]+$ ]]; then
			emit "{\"pct\":$((10#$line))}"
		elif [[ "$line" == "#"* ]]; then
			emit "{\"text\":$(json "${line#\#}")}"
		fi
	done
	exit 0
	;;
"")
	exit 0
	;;
*)
	emit "{\"dialog\":\"$mode\",\"title\":$(json "$title"),\"text\":$(json "$text")}"
	exit 0
	;;
esac
