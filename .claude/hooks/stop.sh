#!/bin/bash
#
# Stop = the turn ended. This hook is a TRIGGER and nothing else: it asks the
# gateway to run its end-of-task flush now, by touching a marker under the
# corpus home that every local gateway observes, including while idle. It says nothing
# to the model.
#
# What it used to be: a per-turn reminder listing the session's unanswered
# searches as "finding-shaped holes" in additionalContext. That is the
# mid-call "please record" the product no longer has. Whether anything is
# written when the flush runs is decided by the gateway, behind
# CAIRN_AUTOWRITE=1 on the door and the gate in src/lib/cairn/autowrite.ts;
# with the flag off (the install default) the flush writes nothing.
#
# The home is resolved the way the doors resolve it: CAIRN_HOME if set, else
# the CAIRN_HOME the `cairn` entry in ~/.claude.json carries, else nothing.
set -uo pipefail

cat >/dev/null # the event body; nothing in it is needed
command -v node >/dev/null 2>&1 || exit 0

HOME_DIR="${CAIRN_HOME:-}"
if [ -z "$HOME_DIR" ]; then
  HOME_DIR="$(node -e '
const fs = require("fs"), path = require("path"), os = require("os");
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(process.env.HOME || os.homedir(), ".claude.json"), "utf8"));
  const servers = cfg.mcpServers || {};
  const pick = (servers.cairn && servers.cairn.env && servers.cairn.env.CAIRN_HOME) ||
    Object.values(servers).map((s) => s && s.env && s.env.CAIRN_HOME).find(Boolean) || "";
  process.stdout.write(String(pick));
} catch {}' 2>/dev/null)"
fi
[ -n "$HOME_DIR" ] || exit 0
[ -d "$HOME_DIR/cairn" ] || exit 0

node "$(dirname "$0")/../../bin/cairn-flush.js" --home "$HOME_DIR"
exit 0
