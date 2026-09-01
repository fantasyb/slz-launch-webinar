#!/usr/bin/env bash
#
# One command, after cloning, to get a working install.
#
#   git clone <repo> ~/cairn && cd ~/cairn && ./install.sh
#
# There is deliberately no `curl ... | bash` here. Pointing a shell — or an
# agent — at a URL and running what comes back authorises a LOCATION and
# whoever controls it later, which is a standing remote-code-execution
# primitive. This project recorded that as a finding (cairn-0014) and refuses
# to serve one, so the clone is the trust decision and this script is code you
# already have on disk and can read.
set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(pwd)"
say() { printf '  %s\n' "$*"; }

printf '\n  Cairn — installing into %s\n\n' "$ROOT"

# Node 20+: the CLI bundle targets it, and the failure on older runtimes is a
# syntax error inside a bundled file, which reads as a corrupt download.
if ! command -v node >/dev/null 2>&1; then
  say "node is not on PATH. Install Node 20 or newer, then re-run this."
  exit 1
fi
MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$MAJOR" -lt 20 ]; then
  say "node $(node -v) is too old — this needs 20 or newer."
  exit 1
fi
say "node $(node -v)"

# `npm ci` when the lockfile agrees, because it is reproducible and faster;
# `npm install` otherwise rather than failing on a lockfile drift nobody here
# can fix.
if [ -f package-lock.json ] && npm ci --silent >/dev/null 2>&1; then
  say "dependencies installed (npm ci)"
elif npm install --silent >/dev/null 2>&1; then
  say "dependencies installed (npm install)"
else
  say "dependency install failed. Run 'npm install' to see why."
  exit 1
fi

if npm run cairn:build-cli >/dev/null 2>&1; then
  say "cli built"
else
  say "cli build failed — the launchers still work via tsx, about 700ms slower."
fi

# Prove it, rather than announcing success and leaving the first real use to
# discover otherwise. A fresh install that cannot answer a question it
# certainly knows about is broken, and saying so here costs one second.
OUT="$(node "$ROOT/bin/cairn-find.js" "/bin/sh: 1: nslookup: not found" 2>&1 || true)"
if printf '%s' "$OUT" | grep -q 'cairn-'; then
  say "self-test passed — the corpus answers"
else
  say "SELF-TEST FAILED: a known query returned nothing."
  printf '%s\n' "$OUT" | sed 's/^/      /'
  exit 1
fi

cat <<EOF

  Installed. Nothing executes unless you enable it (see EXECUTION.md).

  Give an agent access by pasting this into its instruction file
  (CLAUDE.md, AGENTS.md, .cursorrules — whatever it reads):

  ----------------------------------------------------------------
  ## Cairn — recorded traps from this team

  A ledger of things that do not work. Use it without being asked.

  At the start of a session, refresh it:
      node $ROOT/bin/cairn-sync.js

  Before building in unfamiliar territory, say what you are about to do:
      node $ROOT/bin/cairn-brief.js "<what you are about to build>"

  When something fails in a way you did not expect, paste the error:
      node $ROOT/bin/cairn-find.js "<paste the failure output>"

  When you lose more than a few minutes to behaviour that contradicted a
  reasonable expectation, record it once you have solved it:
      node $ROOT/bin/cairn-record.js --file <finding.json>

  Silence means nothing is recorded about it. That is the common case.
  Never put anything in a finding you would not publish.
  ----------------------------------------------------------------

  Or have it installed for you:  npm run cairn:install -- --into <project>

  Note: queries are written to data/retrievals/ and committed. Tell people
  before they start — error text carries paths, hostnames and sometimes
  secrets.

EOF
