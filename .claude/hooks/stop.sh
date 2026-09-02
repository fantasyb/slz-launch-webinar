#!/bin/bash
#
# The corpus already knows what it did not know.
#
# "Bank that" needs a person who noticed they had struggled. An agent running
# unattended has nobody, and asking it to introspect is the weakest available
# trigger: having just solved something is exactly the state in which it does
# not feel hard. So do not ask. Every search is written to the ledger with
# what came back, so a search the corpus could not usefully answer is a
# finding-shaped hole, timestamped at the moment it opened, by a mechanism
# with no opinion.
#
# THREE THINGS THIS HAS TO GET RIGHT, each of which the first version did not:
#
#   Plain stdout from this event goes to the debug log, not to the model.
#   Claude Code adds plain-text stdout as context for four events and Stop is
#   not one of them, so the reminder has to be JSON.
#
#   Stop fires once per TURN, not once per session. Printing the same list
#   every turn is a nag, so it speaks only when the hole set has grown since
#   it last spoke.
#
#   `decision: block` continues the turn. Without honouring stop_hook_active
#   that is an infinite loop.
set -uo pipefail

IN="$(cat)"
ROOT="${CAIRN_ROOT:-${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}}"
command -v node >/dev/null 2>&1 || exit 0
cd "$ROOT" 2>/dev/null || exit 0

FIELD() { printf '%s' "$IN" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  try{const j=JSON.parse(s);process.stdout.write(String(j[process.argv[1]]??""));}catch{}
});' "$1" 2>/dev/null; }

# Already continuing because of this hook: say nothing, or it never ends.
[ "$(FIELD stop_hook_active)" = "true" ] && exit 0

SESSION="$(FIELD session_id)"
[ -n "$SESSION" ] && export CAIRN_SESSION="$SESSION"

HOLES="$(timeout 15 npx tsx scripts/unanswered.ts 2>/dev/null)"
[ -n "$HOLES" ] || exit 0

# Only when it grew. A per-turn reminder that repeats is one that gets
# ignored, and the whole value here is that it is rare enough to read.
STATE="${TMPDIR:-/tmp}/cairn-holes-${SESSION:-adhoc}"
SIG="$(printf '%s' "$HOLES" | grep -c '^  - ' || true)"
[ -f "$STATE" ] && [ "$(cat "$STATE" 2>/dev/null)" = "$SIG" ] && exit 0
printf '%s' "$SIG" > "$STATE"

printf '%s' "$HOLES" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  process.stdout.write(JSON.stringify({
    hookSpecificOutput:{hookEventName:"Stop",additionalContext:s.trim()},
  }));
});'
