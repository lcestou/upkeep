#!/bin/bash
# Gives the old updater's GitHub lookups the owner's token, so a check is not held to the anonymous 60 an hour.
# The header goes to api.github.com only.

real="${UPKEEP_REAL_CURL:-/usr/bin/curl}"
if [ -n "$UPKEEP_CURL_AUTH" ] && [ -r "$UPKEEP_CURL_AUTH" ]; then
	for a in "$@"; do
		case "$a" in
		https://api.github.com/*) exec "$real" -H @"$UPKEEP_CURL_AUTH" "$@" ;;
		esac
	done
fi
exec "$real" "$@"
