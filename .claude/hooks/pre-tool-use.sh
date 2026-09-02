#!/bin/bash
#
# Warn before the tool call, not after the failure.
#
# cairn-0035 named the gap this closes: a trap entered by USING something
# falls between the two delivery paths. `find` is a pull — you search after
# it has already cost you an afternoon. The session-start brief is a push, but
# it fires once, before anyone knows what the session will touch. A tool call
# is the moment in between: the agent has decided what it is about to do, and
# has not done it yet.
#
# That makes the trigger the tool name. An MCP server's quirks — a tool that
# returns empty instead of erroring, one that truncates silently, one that
# reports success on a partial write — are recorded against the tool, and this
# hands them over the next time anyone reaches for it.
#
# Advice, never a gate. It exits 0 on every path, including its own failures:
# a hook that can block a tool call is a hook people turn off.
set -uo pipefail

INPUT="$(cat)"
ROOT="${CAIRN_ROOT:-${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}}"
command -v node >/dev/null 2>&1 || exit 0

# The tool name, and for Bash the command itself — a shell command names its
# program, which is what the existing triggers in this corpus match on.
TOOL="$(printf '%s' "$INPUT" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  try{const j=JSON.parse(s);const i=j.tool_input||{};
    process.stdout.write(j.tool_name==="Bash"?(i.command||""):(j.tool_name||""));
  }catch{}
});' 2>/dev/null)"
[ -n "$TOOL" ] || exit 0

OUT="$(cd "$ROOT" 2>/dev/null && timeout 10 node bin/cairn-find.js --preflight "$TOOL" 2>/dev/null)"

# Silence is the common case and must stay silent: a hook that speaks on every
# tool call is one the reader learns to skip, which is the failure the brief's
# precision-over-recall design exists to avoid.
# A finding id at the start of a line, never the substring "cairn-" anywhere.
# preflight echoes the command back in "nothing known about `...`", so a
# command that merely MENTIONS cairn matched its own text and the hook spoke
# when it had nothing -- which it did, live, on a heredoc containing the
# string "cairn-holes-". Same false positive install.sh had, repeated here.
printf '%s' "$OUT" | grep -qE '^[[:space:]]*!?[[:space:]]*cairn-[0-9]{4}' || exit 0

# AS JSON, because plain stdout from this event reaches the debug log and not
# the model. Claude Code adds plain-text stdout as context for exactly four
# events -- UserPromptSubmit, UserPromptExpansion, SessionStart and
# PostModelSwitch -- and PreToolUse is not one of them. The first version of
# this hook printed the warning and exited 0, which looked perfect in a
# terminal and delivered nothing to the agent: findings would have been banked
# for weeks and never once come back.
printf '%s' "$OUT" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  process.stdout.write(JSON.stringify({
    hookSpecificOutput:{
      hookEventName:"PreToolUse",
      permissionDecision:"allow",
      additionalContext:"Recorded about the tool you are about to use:\n\n"+s.trim()
    }
  }));
});'
