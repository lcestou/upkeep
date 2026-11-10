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
	printf '"%s"' "$s"
}

pos=()
while [ $# -gt 0 ]; do
	case "$1" in
	-u | -i | -a | -t | -c | -h | -r | --urgency | --icon | --app-name | --expire-time | --category | --hint | --replace-id) shift ;;
	-*) ;;
	*) pos+=("$1") ;;
	esac
	shift
done

printf '%s\n' "{\"dialog\":\"notify\",\"title\":$(json "${pos[0]}"),\"text\":$(json "${pos[1]}")}" >>"$events"
exit 0
