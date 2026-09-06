/**
 * cairn:audit-log — read and verify the gateway's tamper-evident decision log.
 *
 *   CAIRN_HOME=~/pilot npm run cairn:audit-log -- view [--limit 50]
 *   CAIRN_HOME=~/pilot npm run cairn:audit-log -- verify
 *   CAIRN_HOME=~/pilot npm run cairn:audit-log -- export [--out audit.jsonl]
 *
 * Distinct from `cairn:audit`, which checks the FORECAST ledger against git
 * history. This is the ENTERPRISE gateway's access log: the gateway appends one
 * hash-chained entry per decision it makes under an org policy — a call allowed,
 * a call denied, an authentication refused. Each entry carries the hash of the
 * one before it, so any edit, deletion, or reorder of a committed entry breaks
 * the chain and `verify` finds exactly where. The raw JSONL IS the SIEM feed:
 * `export` streams it for ingestion.
 *
 * Reads only under CAIRN_HOME/audit. Nothing leaves the machine unless you
 * export it somewhere.
 */
import fs from 'fs';
import path from 'path';
import { cairnHome } from '../src/lib/cairn/home';
import { readAudit, verifyAudit } from '../src/lib/cairn/enterprise';

const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'view';
function opt(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : undefined;
}

let home: string;
try { home = cairnHome(); } catch {
  console.error('cairn:audit-log: no corpus home. Set CAIRN_HOME (e.g. ~/pilot).');
  process.exit(2);
}
const dir = path.join(home, 'audit');

if (cmd === 'verify') {
  const v = verifyAudit(dir);
  if (v.ok) {
    console.log(`cairn:audit-log — chain intact: ${v.entries} entr${v.entries === 1 ? 'y' : 'ies'} verified${v.detail ? ` (${v.detail})` : ''}.`);
    process.exit(0);
  }
  console.error(`cairn:audit-log — CHAIN BROKEN at line ${v.brokenAt}: ${v.detail}`);
  console.error('  An entry was edited, deleted, or reordered after it was written. The log is no longer trustworthy from that point on.');
  process.exit(1);
}

if (cmd === 'export') {
  const src = path.join(dir, 'audit.jsonl');
  let raw: string;
  try { raw = fs.readFileSync(src, 'utf8'); } catch { console.error(`cairn:audit-log — no audit log at ${src}.`); process.exit(1); }
  const out = opt('out');
  if (out) {
    fs.writeFileSync(out, raw);
    console.log(`cairn:audit-log — exported ${raw.split('\n').filter(Boolean).length} entries to ${out}`);
  } else {
    process.stdout.write(raw);
  }
  process.exit(0);
}

if (cmd === 'view') {
  const limit = Number(opt('limit') ?? '50');
  const entries = readAudit(dir, Number.isFinite(limit) && limit > 0 ? limit : 50);
  if (!entries.length) {
    console.log(`cairn:audit-log — no entries yet under ${dir}.`);
    console.log('  The gateway writes here only when an org policy governs it (cairn:org init-policy).');
    process.exit(0);
  }
  const v = verifyAudit(dir);
  console.log(`cairn:audit-log — ${entries.length} most recent (chain ${v.ok ? 'intact' : `BROKEN at line ${v.brokenAt}`}):\n`);
  for (const e of entries) {
    const where = [e.server, e.tool].filter(Boolean).join('/');
    console.log(`  #${String(e.seq).padStart(5)}  ${e.at}  ${e.decision.toUpperCase().padEnd(9)} ${e.principal.padEnd(16)} ${where}${e.reason ? `  — ${e.reason}` : ''}`);
  }
  if (!v.ok) { console.error(`\n  ⚠ the chain is broken at line ${v.brokenAt}: ${v.detail}`); process.exit(1); }
  process.exit(0);
}

console.error(`cairn:audit-log: unknown command "${cmd}". Use: view | verify | export`);
process.exit(1);
