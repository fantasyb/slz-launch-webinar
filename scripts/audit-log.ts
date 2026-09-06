/**
 * cairn:audit-log — read and verify the gateway's tamper-evident decision log.
 *
 *   CAIRN_HOME=~/pilot npm run cairn:audit-log -- view [--limit 50]
 *   CAIRN_HOME=~/pilot npm run cairn:audit-log -- verify [--against <seq>:<hash>]
 *   CAIRN_HOME=~/pilot npm run cairn:audit-log -- anchor
 *   CAIRN_HOME=~/pilot npm run cairn:audit-log -- rotate
 *   CAIRN_HOME=~/pilot npm run cairn:audit-log -- offload <archive.jsonl>
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
 * `anchor` checkpoints the current head — (seq, hash) — for you to store OFF the
 * box (git, a WORM bucket, a webhook). `verify --against <seq>:<hash>` then
 * confirms the live log still matches that anchor: the defense against someone
 * who can rewrite the whole file on the box, since they cannot rewrite an anchor
 * you already took off it. The daemon anchors automatically on its verify tick.
 *
 * Reads only under CAIRN_HOME/audit. Nothing leaves the machine unless you
 * export it somewhere.
 */
import fs from 'fs';
import path from 'path';
import { cairnHome } from '../src/lib/cairn/home';
import { readAudit, verifyAudit, anchorHead, loadAnchorFile, rotateAudit, offloadArchive } from '../src/lib/cairn/enterprise';

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
  // Optionally check against anchors held OFF the box: --against seq:hash (repeatable).
  const against: { seq: number; hash: string }[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--against' && argv[i + 1]) {
      const [s, h] = argv[i + 1].split(':');
      const seq = Number(s);
      if (Number.isFinite(seq) && h) against.push({ seq, hash: h });
      else { console.error(`cairn:audit-log: --against wants <seq>:<hash>, got "${argv[i + 1]}"`); process.exit(2); }
    }
  }
  // --against-file <path>: a full off-box copy of anchors.jsonl. Verify its own
  // chain, then check the live log against every checkpoint in it.
  const fileIdx = argv.indexOf('--against-file');
  if (fileIdx !== -1 && argv[fileIdx + 1]) {
    const loaded = loadAnchorFile(argv[fileIdx + 1]);
    if (!loaded.ok) { console.error(`cairn:audit-log: ${loaded.detail}`); process.exit(1); }
    against.push(...loaded.pairs);
  }
  const v = verifyAudit(dir, against.length ? { against } : {});
  if (v.ok) {
    console.log(`cairn:audit-log — chain intact: ${v.entries} entr${v.entries === 1 ? 'y' : 'ies'} verified${against.length ? `, matches ${against.length} external anchor(s)` : ''}${v.detail ? ` (${v.detail})` : ''}.`);
    process.exit(0);
  }
  console.error(`cairn:audit-log — CHAIN BROKEN${v.brokenAt ? ` at line ${v.brokenAt}` : ''}: ${v.detail}`);
  console.error('  An entry was edited, deleted, reordered, or truncated after it was written. The log is no longer trustworthy from that point on.');
  process.exit(1);
}

if (cmd === 'rotate') {
  const r = rotateAudit(dir);
  if (!r.ok) { console.error(`cairn:audit-log — not rotated: ${r.detail}`); process.exit(1); }
  console.log(`cairn:audit-log — rotated: archived seq ${r.fromSeq}–${r.toSeq} to ${r.archived}.`);
  console.log('  The chain continues in a fresh audit.jsonl from the next entry; existing anchors stay valid.');
  console.log(`  For retention, offload the archive off-box: cairn:audit-log offload ${r.archived}`);
  console.log('  (that removes the local copy and keeps verify/anchor/rotate working — do NOT just delete it).');
  process.exit(0);
}

if (cmd === 'offload') {
  const file = argv[1];
  if (!file || file.startsWith('--')) {
    console.error('cairn:audit-log: offload wants an archive filename, e.g. `offload audit.1-1000.jsonl`.');
    console.error('  List archives: cat "$CAIRN_HOME/audit/audit.segments.jsonl"');
    process.exit(2);
  }
  // Declare the archive offloaded: verified once more, boundary confirmed shipped
  // off-box, then removed locally. Do this BEFORE you move the file off the box —
  // cairn removes the local copy for you once it is safe.
  const r = offloadArchive(dir, file);
  if (!r.ok) { console.error(`cairn:audit-log — not offloaded: ${r.detail}`); process.exit(1); }
  console.log(`cairn:audit-log — offloaded ${r.file} (freed ${r.freedBytes} bytes).`);
  console.log('  The segment is marked offloaded; keep your off-box copy and the boundary anchor.');
  console.log('  On-box verify/anchor/rotate now bridge this range; `verify --against <off-box anchors>` still re-checks it.');
  process.exit(0);
}

if (cmd === 'anchor') {
  const a = anchorHead(dir);
  if (!a) {
    console.log('cairn:audit-log — nothing to anchor (no audit entries yet).');
    process.exit(0);
  }
  console.log(`cairn:audit-log — anchored the head at seq ${a.seq}.`);
  console.log('  Store this OFF the box (git commit, a WORM bucket, an email to yourself). Later:');
  console.log(`    cairn:audit-log verify --against ${a.seq}:${a.hash}`);
  console.log('  If CAIRN_AUDIT_ANCHOR_CMD is set, it was also shipped there automatically.');
  process.exit(0);
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

console.error(`cairn:audit-log: unknown command "${cmd}". Use: view | verify | anchor | rotate | offload | export`);
process.exit(1);
