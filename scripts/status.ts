/**
 * cairn:status — is anyone using this, and is it answering well?
 *
 *   npm run cairn:status
 *
 * The only evidence that reaches anybody else is what gets pushed. Nobody can
 * see another person's machine or session, so "is it working" has to be
 * answerable from the ledger and the corpus alone — and until the ledger
 * existed it was not answerable at all.
 *
 * Reads what is committed. No network, no telemetry, nothing leaves.
 */
import fs from 'fs';
import { readLedger } from '../src/lib/cairn/ledger';
import { loadCorpus } from '../src/lib/cairn/load';
import { homePath } from '../src/lib/cairn/home';
import { freshness, stalenessNote } from '../src/lib/cairn/freshness';

const rows = readLedger();
const corpus = loadCorpus();

console.log(`\nCAIRN STATUS — ${homePath()}`);
console.log('='.repeat(66));

if (rows.length === 0) {
  console.log('\n  No retrievals recorded. Either nobody has used it, or nobody');
  console.log('  has pushed their shard. Both look the same from here, which is');
  console.log('  worth knowing before concluding anything.\n');
} else {
  const by = new Map<string, number>();
  for (const r of rows) by.set(r.by, (by.get(r.by) ?? 0) + 1);
  const at = rows.map((r) => Date.parse(r.at)).filter((n) => !Number.isNaN(n)).sort();
  const days = at.length > 1 ? (at[at.length - 1] - at[0]) / 86_400_000 : 0;

  console.log(`\n  ${rows.length} queries from ${by.size} agent(s) over ${days.toFixed(1)} days\n`);
  for (const [who, n] of [...by].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(5)}  ${who}`);
  }

  /*
   * Confident vs quiet, because a corpus that answers everything is worse than
   * one that answers less. `surfaced` means it led the results; a query with
   * nothing surfaced is the retriever declining to claim, which is a success.
   */
  let confident = 0;
  let quiet = 0;
  for (const r of rows) {
    const top = r.returned[0];
    if (top && top.strength === 'strong') confident++;
    else quiet++;
  }
  const pc = (n: number) => `${((n / rows.length) * 100).toFixed(0)}%`;
  console.log(`\n  answered confidently   ${String(confident).padStart(5)}  ${pc(confident)}`);
  console.log(`  stayed quiet or weak   ${String(quiet).padStart(5)}  ${pc(quiet)}`);
  console.log('\n  Neither number is good or bad on its own. A corpus asked mostly');
  console.log('  about things it does not cover SHOULD be mostly quiet.');

  const recent = rows.slice(-5);
  console.log('\n  most recent queries:\n');
  for (const r of recent) {
    const top = r.returned[0];
    console.log(`    ${(top ? `${top.id} ${top.strength}` : 'nothing').padEnd(22)} ${r.query.replace(/\s+/g, ' ').slice(0, 56)}`);
  }
}

/* Who is actually contributing knowledge, as opposed to consuming it. */
const authors = new Map<string, number>();
for (const f of corpus) for (const o of f.observations ?? []) authors.set(o.by, (authors.get(o.by) ?? 0) + 1);
console.log(`\n  ${corpus.length} findings, ${[...authors.keys()].length} observer(s)\n`);
for (const [who, n] of [...authors].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`    ${String(n).padStart(5)}  ${who}`);
}
if (authors.size === 1) {
  console.log('\n  ONE OBSERVER. Every number this project reports is one author');
  console.log('  marking their own work until that changes.');
}

const note = stalenessNote(freshness());
console.log(note ? `\n  ${note}\n` : '\n  Corpus is current.\n');
