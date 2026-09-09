#!/bin/bash
# A stand-in for the Claude CLI, used by scripts/e2e-hooks-smoke.mjs.
#
# The shell shim riven installs runs `${RIVEN_REAL_CLAUDE:-claude}` with
# `--settings <file>` appended (src/main/pty.ts), so pointing RIVEN_REAL_CLAUDE
# at this script exercises the ENTIRE hook path — shim → settings file → the
# hook command → curl → main's /hook route → activity state machine → renderer
# badge — with only the model itself replaced. No quota, no network.
#
# It reads the settings file it was handed, pulls out the UserPromptSubmit and
# Stop hook commands, and runs them the way the real CLI does: the event JSON on
# stdin. In between it stays "busy" long enough for the badge to be observed.
set -uo pipefail

SETTINGS=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--settings" ]; then SETTINGS="$arg"; fi
  prev="$arg"
done

if [ -z "$SETTINGS" ] || [ ! -f "$SETTINGS" ]; then
  echo "fake-claude: no --settings file in argv" >&2
  exit 2
fi

# Pull the first hook command for an event out of the settings JSON. Uses node
# (always present — this runs from the repo) rather than assuming jq.
hook_cmd() {
  node -e '
    const fs = require("fs")
    const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
    const groups = s.hooks?.[process.argv[2]] ?? []
    for (const g of groups) for (const h of g.hooks ?? []) if (h.command) { console.log(h.command); process.exit(0) }
  ' "$SETTINGS" "$1"
}

run_hook() {
  local event="$1"
  local cmd
  cmd=$(hook_cmd "$event")
  if [ -z "$cmd" ]; then
    echo "fake-claude: no $event hook in $SETTINGS" >&2
    return 0
  fi
  printf '{"hook_event_name":"%s","session_id":"fake"}' "$event" | bash -c "$cmd" >/dev/null 2>&1
}

run_hook UserPromptSubmit
# Long enough that the smoke test can observe the busy badge, short enough not
# to slow the run down.
sleep 1.5
echo "FAKE-CLAUDE-OK"
run_hook Stop
exit 0
