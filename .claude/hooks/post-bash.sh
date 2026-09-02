#!/bin/bash
#
# Fail-then-recover, on Bash: the detector half of "never let the machine
# write; never make the human remember."
#
# The consumer who asked for this said where the signal is: not a failure,
# which is noisy and teaches dismissal, but the arc -- a command fails, work
# happens, the same program works. That arc means "I was wrong about how
# this behaves and then learned the real behaviour", and it is the moment
# the knowledge is cheapest and the one the agent is worst at noticing,
# because it passes in the blur of getting unblocked.
#
# So this remembers, and the agent judges: on a later success under the same
# key it puts ONE question in front of the agent, pre-filled with both calls
# verbatim from the transcript, with THREE answers. Bank it. My mistake -- a
# slip the agent made. Not surprising -- a real failure it already
# understood. Two distinct discards, because only one is an error and
# neither is a trap; and the three tallies are the detector's calibration,
# so each answer is recorded (through the gateway, in ~/.cairn/arcs.jsonl)
# beside the offer this writes. A discard is remembered -- a slip for a
# week, an expected failure for ninety days -- so the same arc is not the
# nag that gets muted. See src/lib/cairn/arcs.ts.
#
# Built for recall. A fixed typo fires it; the tap pays for the precision.
# It writes nothing anywhere but its own state and the offer line. Claude
# Code only, advisory only: additionalContext reaches the model with the
# result that closed the arc, and never blocks.
set -uo pipefail

IN="$(cat)"
command -v node >/dev/null 2>&1 || exit 0

printf '%s' "$IN" | node -e '
let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
  let j; try { j = JSON.parse(s); } catch { return; }
  if (j.tool_name !== "Bash") return;
  const cmd = String((j.tool_input || {}).command || "");
  if (!cmd.trim()) return;
  const r = j.tool_response || {};
  const text = [r.stdout, r.stderr, typeof r === "string" ? r : ""].filter(Boolean).map(String).join("\n");
  let failed = false;
  if (typeof r.exit_code === "number") failed = r.exit_code !== 0;
  else if (typeof r.exitCode === "number") failed = r.exitCode !== 0;
  else if (r.is_error === true || r.isError === true) failed = true;
  else failed = /\bexit(?:ed)?(?: with)?(?: code)?[: ]+([1-9]\d*)/i.test(text);
  const first = cmd.split(/\|\||&&|[|;&\n]/)[0].trim().split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  const wrappers = new Set(["sudo","env","time","nohup","xargs","npx","bunx","pnpm","npm","node","bun","deno","python","python3","sh","bash","zsh","command","exec","nice","timeout","watch"]);
  let i = 0; while (i < first.length - 1 && wrappers.has(first[i].replace(/^.*\//, "").toLowerCase())) i++;
  const prog = (first[i] || "").replace(/^.*\//, "").toLowerCase();
  if (!/^[a-z][a-z0-9._-]*$/.test(prog)) return;
  const trivial = new Set(["cd","ls","cat","echo","pwd","mkdir","rm","cp","mv","touch","head","tail","wc","sed","awk","grep","find","sleep","true","false","test","which","printf","export","source","chmod","chown","ln","tee","sort","uniq","cut","tr","date","kill","ps"]);
  if (trivial.has(prog)) return;
  const sub = first[i + 1] && /^[a-z][a-z0-9-]+$/i.test(first[i + 1]) ? " " + first[i + 1].toLowerCase() : "";
  const key = prog + sub;
  const fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto");
  const session = String(j.session_id || "adhoc").replace(/[^A-Za-z0-9_-]/g, "_");
  const file = path.join(process.env.TMPDIR || "/tmp", "cairn-bash-" + session + ".json");
  let state = { holes: {}, fired: [] };
  try { state = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  const tail = (t) => t.replace(/\s+/g, " ").trim().slice(-400);
  if (failed) {
    state.holes[key] = { command: cmd.slice(0, 2000), output: tail(text), at: new Date().toISOString() };
    fs.writeFileSync(file, JSON.stringify(state));
    return;
  }
  const hole = state.holes[key];
  if (!hole || state.fired.some((f) => f.key === key)) return;
  delete state.holes[key];
  /* The memory of earlier answers, per person per machine. Same rules as src/lib/cairn/arcs.ts. */
  const arc = "arc-" + crypto.createHash("sha256").update(key + "\n" + hole.command.trim()).digest("hex").slice(0, 8);
  const arcsFile = process.env.CAIRN_ARCS || path.join(os.homedir(), ".cairn", "arcs.jsonl");
  const life = { "my-mistake": 7, "not-surprising": 90, bank: 30 };
  let arcs = [];
  try { arcs = fs.readFileSync(arcsFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch {}
  const now = Date.now();
  const live = arcs.filter((a) => a.choice !== "offered" && (now - Date.parse(a.at)) / 86400000 <= (life[a.choice] || 0));
  const exact = live.filter((a) => a.arc === arc).sort((a, b) => (a.at < b.at ? 1 : -1))[0];
  const program = live.filter((a) => a.key === key && a.choice === "not-surprising").length;
  state.fired.push({ key, arc, at: new Date().toISOString(), failing: hole.command, working: cmd.slice(0, 2000), muted: exact ? exact.choice : program >= 3 ? "not-surprising x" + program : null });
  fs.writeFileSync(file, JSON.stringify(state));
  if (exact || program >= 3) return;
  try { fs.mkdirSync(path.dirname(arcsFile), { recursive: true }); fs.appendFileSync(arcsFile, JSON.stringify({ at: new Date().toISOString(), arc, key, failing: hole.command.slice(0, 2000), choice: "offered" }) + "\n"); } catch {}
  const note = { arc, title: "", tool: key, evidence: [ { command: hole.command, output: hole.output || "(no output kept)" }, { command: cmd, output: "(succeeded)" } ], workaround: "" };
  const ctx =
    "--- from your Cairn hooks, not from the command ---\n" +
    "Fail-then-recover detected on `" + key + "`: it failed (" + (hole.output ? hole.output.slice(0, 200) : "no output kept") + ") and then worked. " +
    "Trap worth banking, or your own slip? Answer with one call:\n" +
    "- bank it:         cairn_note " + JSON.stringify(note) + "  (fill title and workaround; cairn_record with \"arc\":\"" + arc + "\" if you already know the claim)\n" +
    "- my mistake:      cairn_note {\"dismiss\":\"" + arc + "\",\"as\":\"my-mistake\"}       (a slip you made; not offered again for a week)\n" +
    "- not surprising:  cairn_note {\"dismiss\":\"" + arc + "\",\"as\":\"not-surprising\"}   (a failure you already understood; not offered again for ninety days)\n" +
    "Nothing is recorded unless you answer; an unanswered offer is counted as one.\n" +
    "--- end ---";
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: ctx } }));
});' 2>/dev/null
exit 0
