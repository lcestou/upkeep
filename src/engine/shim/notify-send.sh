#!/bin/bash
# Upkeep stands in for notify-send while the old updater runs: the window shows the outcome instead.

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
	# Any other control character is invalid inside a JSON string: \u-escape it.
	local i h c u
	for i in {1..31} 127; do
		printf -v h '%02x' "$i"
		printf -v c "\\x$h"
		printf -v u '\\u%04x' "$i"
		s=${s//"$c"/$u}
	done
	printf '"%s"' "$s"
}

pos=()
while [ $# -gt 0 ]; do
	case "$1" in
	-u | -i | -a | -t | -c | -h | -r | -A | --urgency | --icon | --app-name | --expire-time | --category | --hint | --replace-id | --action) shift ;;
	-*) ;;
	*) pos+=("$1") ;;
	esac
	shift
done

printf '%s\n' "{\"dialog\":\"notify\",\"title\":$(json "${pos[0]}"),\"text\":$(json "${pos[1]}")}" >>"$events"
exit 0
