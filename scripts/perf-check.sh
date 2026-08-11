#!/bin/bash
# Pre-release performance gate.
#
# Launches the built app against an isolated data dir and measures the things that have actually
# broken before: a runaway CPU loop, memory that keeps climbing, leaked child processes (each dead
# `claude` used to spin a pipe reader at 100%), and crashes/exceptions on launch. Two scenarios:
# a cold launch, and a restore of a large transcript (the case that pegged autolayout).
#
# On success it writes a marker that the ship hook looks for, so a release can't skip this.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

BIN=".build/debug/Riven"
DATA="/private/tmp/riven-perfcheck/data"
WS="/private/tmp/riven-perfcheck/ws"
MARKER="/tmp/riven-perf-check.ok"
FAIL=0

say() { printf "%s\n" "$*"; }
fail() { say "❌ $*"; FAIL=1; }

say "== build =="
swift build 2>&1 | grep -E "error:|warning: .*never used|Build complete" | tail -3
[ -x "$BIN" ] || { fail "binary missing ($BIN)"; exit 1; }

rm -rf /private/tmp/riven-perfcheck; mkdir -p "$DATA" "$WS"
echo "console.log('hi')" > "$WS/sample.js"

launch() {  # $1 = label
  pkill -f "$BIN $WS" 2>/dev/null; sleep 1
  RIVEN_DATA_DIR="$DATA" "$PWD/$BIN" "$WS" >/tmp/riven-perfcheck.log 2>&1 &
  sleep 6
  PID=$(pgrep -f "$BIN $WS" | head -1)
  [ -n "$PID" ] || { fail "$1: app did not start"; return 1; }
  echo "$PID"
}

sample() {  # $1 = pid, $2 = label → echoes "maxcpu firstrss lastrss"
  local pid=$1 max=0 first="" last=""
  for _ in 1 2 3 4 5 6; do
    read -r c r <<<"$(ps -o %cpu=,rss= -p "$pid" 2>/dev/null)"
    [ -z "${c:-}" ] && break
    [ -z "$first" ] && first=$r
    last=$r
    awk -v a="$c" -v b="$max" 'BEGIN{exit !(a>b)}' && max=$c
    sleep 1.5
  done
  echo "$max $first $last"
}

check() {  # $1 = label, $2 = pid
  local label=$1 pid=$2
  read -r maxcpu first last <<<"$(sample "$pid" "$label")"
  local kids fds
  kids=$(pgrep -P "$pid" 2>/dev/null | wc -l | tr -d ' ')
  fds=$(lsof -p "$pid" 2>/dev/null | wc -l | tr -d ' ')
  say "$label: maxCPU=${maxcpu}%  RSS ${first}KB → ${last}KB  children=$kids  fds=$fds"
  # thresholds: idle must not spin, and memory must not climb >15% while doing nothing
  awk -v c="$maxcpu" 'BEGIN{exit !(c>25)}' && fail "$label: CPU stayed high (${maxcpu}%) while idle"
  awk -v a="$first" -v b="$last" 'BEGIN{exit !(b>a*1.15 && b-a>20000)}' && fail "$label: RSS climbed ${first}→${last}KB"
  grep -qiE "exception|fatal error|Unable to simultaneously satisfy" /tmp/riven-perfcheck.log \
    && fail "$label: exceptions/constraint errors in the log"
}

say "== scenario 1: cold launch =="
PID=$(launch "cold") && check "cold launch" "$PID"

say "== scenario 2: restore a 400-message chat =="
python3 - "$WS" "$DATA" <<'PY'
import json, os, sys
ws, data = sys.argv[1], sys.argv[2]
sid = "perfcheck-0000-0000-0000-00000000ffff"
enc = "".join(c if c.isalnum() else "-" for c in ws)
proj = os.path.expanduser(f"~/.claude/projects/{enc}"); os.makedirs(proj, exist_ok=True)
code = "```python\ndef f(x):\n    return x*x\n```"
lines = []
for i in range(400):
    if i % 2 == 0:
        lines.append(json.dumps({"type": "user", "message": {"role": "user", "content": f"question {i}"}}))
    else:
        lines.append(json.dumps({"type": "assistant", "message": {"role": "assistant",
                     "content": [{"type": "text", "text": f"answer {i}\n\n{code}\n\ndetail."}]}}))
open(f"{proj}/{sid}.jsonl", "w").write("\n".join(lines) + "\n")
u = "file://" + ws + "/"
open(f"{data}/settings.json", "w").write(json.dumps({"session": {
    "workspaces": [u], "active": u, "colors": {}, "names": {}, "tabs": {}, "activeTab": {},
    "layout": {u: {"type": "group", "panels": [f"chat:{sid}"], "active": 0}}}}))
print("seeded 400-message restore")
PY
PID=$(launch "restore") && check "heavy restore" "$PID"

pkill -f "$BIN $WS" 2>/dev/null
rm -f "$HOME/.claude/projects/$(echo "$WS" | sed 's/[^a-zA-Z0-9]/-/g')/perfcheck-0000-0000-0000-00000000ffff.jsonl"

if [ "$FAIL" -eq 0 ]; then
  date +%s > "$MARKER"
  say "✅ perf check passed - marker written ($MARKER)"
else
  rm -f "$MARKER"
  say "❌ perf check FAILED - fix before releasing"
fi
exit "$FAIL"
