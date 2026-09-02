/**
 * cairn:report — what the gateway did for your agents, per tool.
 *
 *   npm run cairn:report              # since the beginning of the ledger
 *   npm run cairn:report -- --days 30
 *   npm run cairn:report -- --json
 *
 * This is the number somebody carries into a budget meeting, and it is
 * computed only from what the gateway itself wrote down: every annotation it
 * emitted (by surface), every call it forwarded, every error it saw, and
 * every draft it opened when a failed call was followed by a working one.
 * Nothing here comes from the eval suites -- those rows are excluded at the
 * source (CAIRN_EVAL) -- and nothing comes from `cli:find`, which is a person
 * asking a question and not a delivery.
 *
 * WHAT IT CANNOT SAY, printed rather than implied: a trap that is
 * success-shaped leaves no error, so "calls after a warning that did not
 * error" is not "traps avoided". The only mechanical outcome signal the
 * gateway has is isError. Correctness needs a grader, and the gateway is not
 * one. The two-arm trial in data/gateway-trials is where correctness was
 * measured; this report is where delivery is counted.
 */
import { readLedger, type RetrievalRecord } from '../src/lib/cairn/ledger';
import { cairnHome } from '../src/lib/cairn/home';

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const daysAt = argv.indexOf('--days');
const DAYS = daysAt !== -1 ? Number(argv[daysAt + 1]) : Infinity;
const since = Number.isFinite(DAYS) ? Date.now() - DAYS * 86_400_000 : 0;

const SURFACES = ['connect-index', 'first-contact', 'description', 'argument', 'result', 'result-reminder'] as const;

interface ToolRow {
  tool: string;
  calls: number;
  errors: number;
  served: Record<string, number>;
  findings: Set<string>;
  sessionsWarned: Set<string>;
  sessionsCalled: Set<string>;
  drafts: number;
}

const rows = readLedger().filter((r) => (r.source ?? '').startsWith('mcp-proxy:') && Date.parse(r.at) >= since);
const byTool = new Map<string, ToolRow>();
const row = (tool: string): ToolRow => {
  let t = byTool.get(tool);
  if (!t) {
    t = { tool, calls: 0, errors: 0, served: {}, findings: new Set(), sessionsWarned: new Set(), sessionsCalled: new Set(), drafts: 0 };
    byTool.set(tool, t);
  }
  return t;
};
const sessions = new Set<string>();
const agents = new Set<string>();

for (const r of rows) {
  sessions.add(r.session ?? 'adhoc');
  agents.add(r.by);
  const kind = (r.source ?? '').slice('mcp-proxy:'.length);
  const tool = r.query.split(/\s+/)[0];
  const t = row(tool);
  if ((SURFACES as readonly string[]).includes(kind)) {
    t.served[kind] = (t.served[kind] ?? 0) + 1;
    for (const h of r.returned ?? []) t.findings.add(h.id);
    t.sessionsWarned.add(r.session ?? 'adhoc');
  } else if (kind === 'call') {
    t.calls++;
    t.sessionsCalled.add(r.session ?? 'adhoc');
  } else if (kind === 'error') {
    t.errors++;
    t.sessionsCalled.add(r.session ?? 'adhoc');
  } else if (kind === 'draft') {
    t.drafts++;
  }
}

const tools = [...byTool.values()].sort((a, b) => b.calls + b.errors - (a.calls + a.errors));
const unrecorded = tools.filter((t) => t.errors > 0 && t.findings.size === 0);

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      {
        corpus: cairnHome(),
        days: Number.isFinite(DAYS) ? DAYS : null,
        sessions: sessions.size,
        agents: [...agents],
        tools: tools.map((t) => ({
          tool: t.tool,
          calls: t.calls,
          errors: t.errors,
          served: t.served,
          findings: [...t.findings],
          sessionsWarned: t.sessionsWarned.size,
          sessionsCalled: t.sessionsCalled.size,
          drafts: t.drafts,
        })),
        unrecordedFailures: unrecorded.map((t) => ({ tool: t.tool, errors: t.errors })),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

console.log(`\nCAIRN GATEWAY REPORT — ${cairnHome()}${Number.isFinite(DAYS) ? ` — last ${DAYS} days` : ''}`);
console.log('='.repeat(66));
if (!rows.length) {
  console.log('\n  The gateway has recorded nothing yet. Either no session has gone');
  console.log('  through it, or CAIRN_HOME points somewhere else.\n');
  process.exit(0);
}
console.log(`\n  ${sessions.size} session(s) from ${agents.size} client(s): ${[...agents].join(', ')}\n`);
console.log('  tool                               calls  errors  warned-in  findings  drafts');
for (const t of tools) {
  const servedTotal = Object.values(t.served).reduce((a, b) => a + b, 0);
  console.log(
    `  ${t.tool.slice(0, 34).padEnd(34)} ${String(t.calls).padStart(5)}  ${String(t.errors).padStart(6)}  ` +
      `${String(t.sessionsWarned.size).padStart(4)}/${String(t.sessionsCalled.size).padEnd(4)} ${String(t.findings.size).padStart(5)}    ${String(t.drafts).padStart(4)}` +
      (servedTotal ? `   (${Object.entries(t.served).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''),
  );
}
console.log('\n  warned-in: sessions that were shown a finding for the tool / sessions that called it.');
if (unrecorded.length) {
  console.log('\n  FAILED WITH NOTHING RECORDED — the holes worth filling first:');
  for (const t of unrecorded) console.log(`    ${t.tool}  ${t.errors} error(s)`);
}
console.log(
  '\n  A success-shaped trap leaves no error, so calls that did not error are not\n' +
    '  traps avoided. Correctness is measured by the trial in data/gateway-trials,\n' +
    '  not here; this counts delivery, which the gateway can see.\n',
);
