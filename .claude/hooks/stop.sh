#!/bin/bash
#
# The corpus already knows what it did not know.
#
# "Bank that" needs a person in the loop, and an autonomous agent has nobody
# to say it. The hard part is not writing the finding — the twelve-trial run
# showed agents can — it is NOTICING the moment, and self-assessment is the
# weakest possible trigger: an agent that has just solved something does not
# feel that it struggled.
#
# So do not ask the agent to introspect. Use the record the system already
# keeps. Every search is written to the ledger with what came back, so a query
# that returned NOTHING is a finding-shaped hole, logged at the instant it
# opened, by a mechanism with no opinion. If the agent went on to solve that
# thing, the corpus should have it and does not.
#
# This fires when the agent stops, lists this session's silent queries, and
# says so. It never blocks: exit 0 on every path.
set -uo pipefail

ROOT="${CAIRN_ROOT:-${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}}"
command -v node >/dev/null 2>&1 || exit 0
cd "$ROOT" 2>/dev/null || exit 0

timeout 15 npx tsx scripts/unanswered.ts 2>/dev/null || true
