/**
 * The brief a triage agent is spawned with. It is the judgment half of the
 * pipeline written down: what a candidate is, what admission requires, and the
 * exact honest bar (a discriminating one-machine check), so the agent that runs
 * on a live box does the one thing a diskless pass cannot.
 *
 * Kept as data, pure and testable, because it is the contract between the trigger
 * (which spawns) and the agent (which decides). The trigger fills in the home and
 * the pending list; everything else is fixed protocol.
 */
import type { Candidate } from './triage';

/** A one-line digest of a candidate for the brief — enough to judge, not the whole blob. */
function line(c: Candidate): string {
  const d = c.data;
  const tool = String(d.tool ?? '?');
  const expectation = String(d.expectation ?? '').replace(/\s+/g, ' ').slice(0, 160);
  const reality = String(d.reality ?? '').replace(/\s+/g, ' ').slice(0, 160);
  const update = String(d.mechanism_or_update ?? '').replace(/\s+/g, ' ').slice(0, 200);
  return [
    `- ${c.file}`,
    `    tool:        ${tool}`,
    `    expectation: ${expectation}`,
    `    reality:     ${reality}`,
    `    correction:  ${update}`,
  ].join('\n');
}

export function triageBrief(home: string, pending: Candidate[]): string {
  return `You are a Cairn triage agent. Your job is to turn harvested candidates into
findings — or to reject them — using the one thing you have that an offline pass
does not: a live machine you can run a check on.

CORPUS HOME: ${home}
Candidates live in ${home}/drafts/*.json. There are ${pending.length} pending.

WHAT A CANDIDATE IS. Each was scraped from a past session's transcript: the agent's
own expectation before a tool call, what the tool actually returned, and the agent's
correction after. It is a lead, not a finding. Most are not worth keeping.

THE BAR, and it is not a judgment call you get to fudge:
1. Is this a real, general trap in how a TOOL behaves — or the agent thinking aloud
   about its own work? If the latter, reject it.
2. Could the next agent recover the same answer unaided in one turn (the error is on
   stderr, the wrong scope shows in the returned rows)? If so it pays nothing — reject
   it, or at most keep it as a low-value lead. Do not admit locally-recoverable noise.
3. If it survives 1 and 2, write a DISCRIMINATING check: a shell command that exits 0
   when the trap is present, and an \`absentWhen\` that makes the trap not apply on THIS
   machine. A check that exits 0 whether or not the trap is present is worthless — it
   tests that a shell ran. That is the single most common failure; do not produce it.

PROCESS, per candidate:
  a. Forecast blind FIRST: will your check discriminate on this machine? Write the
     probability and one sentence of reasoning before you run anything.
  b. Add \`check\` (command + absentWhen) to the candidate JSON, plus any precondition.
  c. Run: npm run cairn:triage    (it runs the one-machine gate and settles the verdict)
       - discriminates  -> it is admitted; then record it into the corpus with
                           cairn_record (same check), so standing/provenance are correct.
       - same-either-way/no-delta -> rejected. Your check did not discriminate; either
                           fix it or accept this is not a keepable finding.
       - not-live       -> the trap is not present on THIS machine. Leave it; it defers
                           for a session where it is live. Do NOT force it in.
  d. Record what you did and why in one line.

WHEN YOU FINISH, report: how many admitted, rejected, deferred, and the single most
useful finding you admitted (or "none, and here is why"). Be honest about a low yield —
a triage pass that admits nothing because nothing cleared the bar is the system working,
not a failure. Do not pad the corpus to look productive.

PENDING CANDIDATES:
${pending.map(line).join('\n')}
`;
}
