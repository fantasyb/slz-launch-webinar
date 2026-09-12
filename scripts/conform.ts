/**
 * cairn:conform — does this directory of findings conform to the format?
 *
 *   npm run cairn:conform -- <dir or file>...          # shape and static check rules
 *   npm run cairn:conform -- <dir> --run               # and prove each check decides
 *
 * For someone who takes the FORMAT and neither the gateway nor the ranker.
 * Three questions per finding, cheapest first:
 *
 *   1. Is it the shape?         FindingSchema, the same definition the
 *                               loaders use and spec/finding.schema.json is
 *                               generated from.
 *   2. Can its check decide?    The static rules in checkquality.ts: a
 *                               verdict must be in the exit status, not in
 *                               text a human compares.
 *   3. Does it, on this box?    With --run, and only under the machine's
 *                               execution policy: run the check, apply the
 *                               finding's own absentWhen, run it again, and
 *                               report whether the answer moved.
 *
 * Imports nothing from retrieval or the proxy, on purpose. If this file ever
 * needs them the format has stopped being separable, and that is worth
 * knowing before somebody depends on it being separable.
 *
 * Exit 1 on any shape failure; 2 on static-rule failures alone; 0 otherwise.
 * A --run verdict is reported and never fails the exit code, because "could
 * not be shown to discriminate here" is information about this machine as
 * much as about the check.
 */
import fs from 'fs';
import path from 'path';
import { FindingSchema, type Finding } from '../src/lib/cairn/schema';
import { checkFlaws } from '../src/lib/cairn/checkquality';
import { gate } from '../src/lib/cairn/gate';
import { executionPolicy, policyPath } from '../src/lib/cairn/policy';

const argv = process.argv.slice(2);
const RUN = argv.includes('--run');
const targets = argv.filter((a) => !a.startsWith('--'));
if (!targets.length) {
  console.error('usage: cairn:conform -- <dir or file>... [--run]');
  process.exit(2);
}

function files(t: string): string[] {
  if (fs.statSync(t).isDirectory()) {
    return fs.readdirSync(t).filter((f) => f.endsWith('.json')).sort().map((f) => path.join(t, f));
  }
  return [t];
}

interface Row { file: string; shape: 'ok' | string; static: string[]; gate?: string; manual: boolean }

async function main() {
  const rows: Row[] = [];
  const policy = executionPolicy();
  if (RUN && !policy.enabled) {
    console.error(`--run: execution is off on this machine (${policyPath()}); checks are inspected, not run.`);
  }
  for (const t of targets) {
    for (const file of files(t)) {
      let parsed: ReturnType<typeof FindingSchema.safeParse>;
      try {
        parsed = FindingSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
      } catch (e) {
        rows.push({ file, shape: `not JSON: ${(e as Error).message}`, static: [], manual: false });
        continue;
      }
      if (!parsed.success) {
        rows.push({ file, shape: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), static: [], manual: false });
        continue;
      }
      const f: Finding = parsed.data;
      const row: Row = { file, shape: 'ok', static: f.check.manual ? [] : checkFlaws(f.check).map((x) => `${x.rule}: ${x.detail}`), manual: f.check.manual };
      if (RUN && policy.enabled && !f.check.manual && !row.static.length) {
        try {
          const v = await gate(f);
          row.gate = `${v.verdict}${v.detail ? ` — ${v.detail}` : ''}`;
        } catch (e) {
          row.gate = `error — ${(e as Error).message}`;
        }
      }
      rows.push(row);
    }
  }

  let shapeFailures = 0;
  let staticFailures = 0;
  for (const r of rows) {
    const name = path.basename(r.file);
    if (r.shape !== 'ok') { shapeFailures++; console.log(`SHAPE   ${name}\n        ${r.shape}`); continue; }
    if (r.static.length) { staticFailures++; console.log(`CHECK   ${name}\n        ${r.static.join('\n        ')}`); continue; }
    console.log(`ok      ${name}${r.manual ? '  (manual check: inspected, never run)' : ''}${r.gate ? `\n        gate: ${r.gate}` : ''}`);
  }
  console.log(`\n${rows.length} finding(s): ${rows.length - shapeFailures - staticFailures} conform, ${shapeFailures} malformed, ${staticFailures} with a check that cannot decide.`);
  process.exit(shapeFailures ? 1 : staticFailures ? 2 : 0);
}

main();
