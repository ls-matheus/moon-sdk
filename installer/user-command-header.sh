#!/bin/bash
set -euo pipefail
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
line="$(awk '/^__MOON_RESOURCES__$/ {print NR + 1; exit}' "$0")"
tail -n +"$line" "$0" | /usr/bin/base64 -D | tar -xz -C "$work"
/bin/bash "$work/install-user.sh"
exit 0
__MOON_RESOURCES__
