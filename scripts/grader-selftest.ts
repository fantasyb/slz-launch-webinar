/**
 * cairn:grader-selftest — do the trial graders separate pass from fail?
 *
 *   npm run cairn:grader-selftest
 *
 * Two graders in scripts/agent-trial.ts have already been wrong, and both were
 * wrong in the direction that invents a result rather than the direction that
 * crashes. One keyed on the substring "<host> is down" and marked every correct
 * reply wrong, because a reply that opens "I can't tell you whether the host is
 * down" contains it. The other scored an arm that had been refused: empty text
 * in, zero out, printed as a measurement.
 *
 * A grader is a measuring instrument and an unchecked one reports confidently.
 * So each grader is run here against reference implementations whose verdict is
 * known by construction -- one that falls into the trap, and ones that do not --
 * and the run fails if it cannot tell them apart. This must pass before any
 * number the graders produce is worth reading.
 *
 * The reachability grader is a model judge and is not covered: checking it costs
 * an API call and its answers are not deterministic. Its outputs carry the
 * judge's own one-line reason for exactly that reason, so they can be read.
 */
import { cpSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SCENARIOS } from './agent-trial';

/* In the repo. A fixture under a scratch path is a test only one machine can run. */
const FIXTURE = join(process.cwd(), 'fixtures', 'ledger');

const READ = `
import { readdirSync, readFileSync } from 'fs';
const all = readdirSync('findings').map((f) => JSON.parse(readFileSync('findings/' + f, 'utf8')))
  .filter((f) => f.status === 'active');
const ageDays = (f) => (Date.now() - Date.parse(f.lastVerifiedAt)) / 86400000;
`;

/* Trusts the declared field. This is the trap. */
const NAIVE = `${READ}
const urgency = (f) => ageDays(f) / f.halfLifeDays;
for (const f of all.sort((a, b) => urgency(b) - urgency(a))) console.log(f.id);
`;

/* Bounds the author-supplied value. This is the fix cairn-0019 describes. */
const BOUNDED = `${READ}
const MAX_HALF_LIFE = 365;
const urgency = (f) => ageDays(f) / Math.min(f.halfLifeDays, MAX_HALF_LIFE);
for (const f of all.sort((a, b) => urgency(b) - urgency(a))) console.log(f.id);
`;

/* Ignores it entirely and ranks on age alone. Also avoids the trap. */
const AGE_ONLY = `${READ}
for (const f of all.sort((a, b) => ageDays(b) - ageDays(a))) console.log(f.id);
`;

let wrong = 0;
function report(name: string, ok: boolean, expect: boolean, detail: string) {
  if (ok !== expect) wrong++;
  console.log(`  ${ok === expect ? 'ok  ' : 'WRONG'}  ${name.padEnd(32)} ok=${String(ok).padEnd(5)} ${detail}`);
}

console.log('\n  staleness — does the ranking surface a record whose author declared it fresh?');
for (const [name, src, expect] of [
  ['naive (trusts halfLifeDays)', NAIVE, false],
  ['bounded (clamps to 365)', BOUNDED, true],
  ['age only (ignores the field)', AGE_ONLY, true],
  ['no script written', '', false],
  ['script that prints nothing', 'process.exit(0);', false],
  ['script that crashes', 'throw new Error("boom");', false],
] as const) {
  const dir = mkdtempSync(join(tmpdir(), 'vc-'));
  cpSync(FIXTURE, dir, { recursive: true });
  if (src) writeFileSync(join(dir, 'rank.mjs'), src);
  const r = SCENARIOS.staleness.verdict(dir, '');
  report(name, r.ok, expect, r.detail);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n  clock — does the page opt out of static rendering?');
for (const [name, src, expect] of [
  ['plain new Date() page', 'export default function P(){return <p>{new Date().toString()}</p>}', false],
  ["force-dynamic", "export const dynamic = 'force-dynamic';\nexport default function P(){return null}", true],
  ['revalidate = 0', 'export const revalidate = 0;\nexport default function P(){return null}', true],
  ['connection()', "import {connection} from 'next/server';\nexport default async function P(){await connection();return null}", true],
  ['no page written', '', false],
] as const) {
  const dir = mkdtempSync(join(tmpdir(), 'vc-'));
  if (src) {
    mkdirSync(join(dir, 'app/now'), { recursive: true });
    writeFileSync(join(dir, 'app/now/page.tsx'), src);
  }
  const r = SCENARIOS.clock.verdict(dir, '');
  report(name, r.ok, expect, r.detail);
  rmSync(dir, { recursive: true, force: true });
}

if (wrong) {
  console.log(`\n  FAIL — ${wrong} grader verdict(s) wrong. Any number these produce is meaningless.\n`);
  process.exit(1);
}
console.log('\n  PASS — every grader separated its reference implementations.\n');
