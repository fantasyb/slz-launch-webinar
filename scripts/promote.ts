/**
 * Prepare a finding from a private corpus for contribution upstream.
 *
 *   npm run cairn:promote -- cairn-0007
 *
 * A private corpus is where the two-layer model earns its keep: your agents
 * record your environment's traps, and the evidence field carries real error
 * output — internal hostnames, repo paths, service names, ticket ids. That is
 * exactly what makes a finding useful to your team and exactly what cannot be
 * published. Without a promotion step the choice is "never contribute" or
 * "paste and hope", and the second one happens at six in the evening.
 *
 * What this does NOT do is carry other people's signatures across.
 *
 * Redaction changes the body, the body hash is what every observation signature
 * is bound to, so a redacted finding cannot carry a signature made over the
 * unredacted one. That is the binding working, not a limitation to route
 * around: a signature that survived its subject being rewritten would be worth
 * nothing. So promotion emits the claim plus YOUR observation, signed by you,
 * and upstream earns its breadth from people who re-run the check rather than
 * from attestations that were transported.
 */
import fs from 'fs';
import path from 'path';
import { FindingSchema } from '../src/lib/cairn/schema';
import { resolveFindingFile } from '../src/lib/cairn/resolve';
import { writeJsonAtomic } from '../src/lib/cairn/atomic';
import { redact, scanSensitive, scanInjection, scanInvisible } from '../src/lib/cairn/safety';

const id = process.argv[2];
const agent = process.env.CAIRN_AGENT;
if (!id) {
  console.error('usage: CAIRN_AGENT=<you> npm run cairn:promote -- <cairn-NNNN>');
  process.exit(2);
}

let full: string;
try {
  full = resolveFindingFile(id);
} catch (e) {
  console.error((e as Error).message);
  process.exit(2);
}
const finding = FindingSchema.parse(JSON.parse(fs.readFileSync(full, 'utf8')));

/** Prose fields that carry contributor text and therefore carry your details. */
const PROSE = [
  'title', 'claim', 'expectation', 'reality', 'mechanism', 'workaround',
  'derivation', 'appliesTo', 'retiredReason',
] as const;

const out: Record<string, unknown> = { ...finding };
const stripped: Array<{ field: string; pattern: string; original: string }> = [];

for (const field of PROSE) {
  const v = (finding as Record<string, unknown>)[field];
  if (typeof v !== 'string') continue;
  const r = redact(v);
  out[field] = r.text;
  for (const x of r.redactions) stripped.push({ field, pattern: x.pattern, original: x.original });
}

// Evidence is where raw command output lives, so it is the likeliest carrier.
out.evidence = finding.evidence.map((e, i) => {
  const c = redact(e.command), o = redact(e.output), n = redact(e.note ?? '');
  for (const [k, r] of [['command', c], ['output', o], ['note', n]] as const)
    for (const x of r.redactions) stripped.push({ field: `evidence[${i}].${k}`, pattern: x.pattern, original: x.original });
  return { command: c.text, output: o.text, ...(e.note ? { note: n.text } : {}) };
});

// The check is executed by strangers. Redacting it would silently break it, so
// it is reported rather than rewritten: a check that needs your hostnames is
// not portable and should be rewritten by hand before contributing.
const checkFlags = scanSensitive(
  [finding.check.command, finding.check.confirmedIf, finding.check.refutedIf].join('\n'),
);

// Your own observation only. See the header.
const mine = finding.observations.filter((o) => o.by === agent);
out.observations = mine.map((o) => {
  const n = redact(o.note ?? '');
  for (const x of n.redactions) stripped.push({ field: 'observation.note', pattern: x.pattern, original: x.original });
  const { signature: _drop, ...rest } = o;
  return { ...rest, ...(o.note ? { note: n.text } : {}) };
});
out.predictions = [];
delete (out as { retiredReason?: unknown }).retiredReason;

console.log(`\n${finding.id} — prepared for upstream\n`);

if (stripped.length) {
  console.log(`REDACTED ${stripped.length} value(s):`);
  for (const s of stripped) console.log(`  ${s.field.padEnd(24)} ${s.pattern.padEnd(22)} ${s.original.slice(0, 40)}`);
  console.log('');
} else {
  console.log('Nothing matched the redactor.\n');
}

// Re-scan the redacted result. A pattern the redactor knows how to FLAG but not
// how to REWRITE would otherwise be published; refusing is the only safe answer.
const body = JSON.stringify(out);
const residual = [
  ...scanSensitive(body).map((f) => ({ ...f, layer: 'sensitive' })),
  ...scanInjection(body).filter((f) => f.severity === 'block').map((f) => ({ ...f, layer: 'injection' })),
  ...scanInvisible(body).map((f) => ({ ...f, layer: 'invisible' })),
];
if (residual.length || checkFlags.length) {
  console.error('REFUSING to write. The redacted finding still trips the scanner:\n');
  for (const f of residual) console.error(`  ${f.layer}:${f.pattern} — ${f.sample.slice(0, 60)}`);
  for (const f of checkFlags) console.error(`  check:${f.pattern} — ${f.sample.slice(0, 60)} (rewrite the check by hand)`);
  console.error('\nFix the finding in your own corpus first. Nothing was written.');
  process.exit(1);
}

if (mine.length === 0) {
  console.error(`No observation by "${agent ?? '(CAIRN_AGENT unset)'}" on ${finding.id}.`);
  console.error('Promotion carries your own attestation. Record one, or promote a finding you observed.');
  process.exit(2);
}

const dir = path.join(process.cwd(), 'promote');
fs.mkdirSync(dir, { recursive: true });
const dest = path.join(dir, `${finding.id}.json`);
writeJsonAtomic(dest, out);

console.log(`wrote ${path.relative(process.cwd(), dest)}`);
console.log(`  ${mine.length} observation(s) by ${agent}, unsigned — re-sign under the upstream's id`);
console.log('\nNext:');
console.log(`  1. Read it. You are publishing this.`);
console.log(`  2. Copy into a clone of the upstream corpus, renumbering the id to their next free one.`);
console.log(`  3. CAIRN_KEY=<id> CAIRN_AGENT=${agent} npm run cairn:sign`);
console.log(`  4. npm run cairn:lint && open a pull request.`);
