#!/bin/bash
#
# Hand the agent what is wrong with this machine, before it asks.
#
# The measured failure of this whole project is that agents do not ask. A
# weaker model given the corpus as a tool scored 0/5; handed the same findings
# unprompted it scored 4/5. Retrieval accuracy is an upper bound — an agent
# that never queries gets none of it. So the delivery that matters is this
# one, where nothing has to be typed and the machine's own state selects what
# is relevant.
#
# Never fails a session. Every failure path prints nothing and exits 0: a hook
# that blocks work to complain about a ledger of traps has become one.
set -uo pipefail

ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$ROOT" 2>/dev/null || exit 0
command -v node >/dev/null 2>&1 || exit 0
[ -d cairn ] || exit 0

# Bounded hard. This runs before the session and is worth at most a couple of
# seconds; a slow hook is one people disable.
LIVE="$(timeout 25 npx tsx scripts/doctor.ts 2>/dev/null | sed -n '/^LIVE ON THIS MACHINE/,/^$/p' | tail -n +2)"

if [ -z "$LIVE" ]; then
  # Either execution is not enabled for this corpus (EXECUTION.md), or nothing
  # reproduces here. Both are fine and neither is worth a paragraph.
  exit 0
fi

cat <<EOF
## Traps live on this machine right now

Recorded by people who hit them here, and confirmed by running each finding's
own check just now — not matched by keyword. Judge whether each applies.

$LIVE

Search the ledger when something fails unexpectedly:
    node $ROOT/bin/cairn-find.js "<paste the failure output>"
Record a new one once you have solved it:
    node $ROOT/bin/cairn-record.js --file <finding.json>
EOF
