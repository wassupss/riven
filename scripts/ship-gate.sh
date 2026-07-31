#!/bin/bash
# PreToolUse gate: block a release unless the performance check passed recently.
#
# Reads the hook payload on stdin, looks at the Bash command, and denies anything that would cut a
# release (creating/pushing a v* tag, or `gh release create`) when /tmp/riven-perf-check.ok is
# missing or stale. Memory and skills say "verify first"; this makes it impossible to forget.
#
# Exit 0 + no output  → allow.  Exit 0 + JSON deny → blocked with a reason.
set -uo pipefail

MARKER="/tmp/riven-perf-check.ok"
MAX_AGE=3600          # a pass older than an hour doesn't describe the current build

payload=$(cat)
cmd=$(printf '%s' "$payload" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("tool_input",{}).get("command",""))
except Exception: print("")' 2>/dev/null)

# Only guard release-cutting commands.
case "$cmd" in
  *"git tag "*v[0-9]*|*"git push"*" v"[0-9]*|*"gh release create"*) ;;
  *) exit 0 ;;
esac

deny() {
  python3 -c 'import json,sys; print(json.dumps({"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":sys.argv[1]}}))' "$1"
  exit 0
}

[ -f "$MARKER" ] || deny "릴리스 차단: 성능 검증을 아직 안 했습니다. ./scripts/perf-check.sh 를 먼저 실행하세요 (통과해야 태그/릴리스 가능)."

now=$(date +%s); then_=$(cat "$MARKER" 2>/dev/null || echo 0)
age=$(( now - then_ ))
[ "$age" -le "$MAX_AGE" ] || deny "릴리스 차단: 성능 검증 결과가 오래됐습니다 (${age}초 전). 현재 빌드로 ./scripts/perf-check.sh 를 다시 실행하세요."

exit 0
