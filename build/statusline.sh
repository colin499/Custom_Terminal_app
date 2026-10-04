#!/bin/bash
# Installed by Monk (the terminal app). Claude Code pipes a JSON status payload to this script
# after every reply. It is saved per project so Monk can show context and usage, and a short
# status line is printed for Claude Code itself.
DIR="$HOME/Library/Application Support/Monk/status"
mkdir -p "$DIR"
INPUT=$(cat)
[ -z "$INPUT" ] && exit 0

field() { printf '%s' "$2" | grep -o "\"$1\":\"[^\"]*\"" | head -1 | sed "s/\"$1\":\"//; s/\"\$//"; }
PROJ=$(field project_dir "$INPUT"); [ -z "$PROJ" ] && PROJ=$(field cwd "$INPUT")
KEY=$(printf '%s' "$PROJ" | sed 's/[^A-Za-z0-9]/-/g')
[ -n "$KEY" ] && printf '%s' "$INPUT" > "$DIR/$KEY.json.tmp" && mv -f "$DIR/$KEY.json.tmp" "$DIR/$KEY.json"

MODEL=$(field display_name "$INPUT")
CTXPART=${INPUT%%\"rate_limits\"*}
CTX=$(printf '%s' "$CTXPART" | grep -o '"used_percentage":[0-9.]*' | head -1 | sed 's/.*://; s/\..*//')
LIMITS=${INPUT#*\"rate_limits\"}
FIVE=$(printf '%s' "$LIMITS" | grep -o '"five_hour":{"used_percentage":[0-9.]*' | sed 's/.*://; s/\..*//')
WEEK=$(printf '%s' "$LIMITS" | grep -o '"seven_day":{"used_percentage":[0-9.]*' | sed 's/.*://; s/\..*//')
LINE="$MODEL"
[ -n "$CTX" ] && LINE="$LINE · ctx ${CTX}%"
[ -n "$FIVE" ] && LINE="$LINE · 5h ${FIVE}%"
[ -n "$WEEK" ] && LINE="$LINE · 7d ${WEEK}%"
printf '%s' "$LINE"
