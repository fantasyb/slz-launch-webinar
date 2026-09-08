/**
 * cairn:trust — see and manage the gateway's trust pins.
 *
 *   CAIRN_HOME=~/pilot npm run cairn:trust                       # list pinned servers
 *   CAIRN_HOME=~/pilot npm run cairn:trust -- --reapprove <srv>  # TOFU: forget for next process
 *   CAIRN_HOME=~/pilot npm run cairn:trust -- --approve-file <file> --server <srv> --sha256 <reviewed-digest>
 *
 * A pin is the approved surface of a wrapped MCP server — every tool's name,
 * description, annotations, and schema hash, its instructions, and every
 * prompt's name, description and arguments, as they were when first seen. The
 * gateway pins each server on first sight; in enforce mode it withholds any tool
 * or prompt whose definition later changed (the tool-poisoning / rug-pull
 * defense) until it is re-approved. When a change is a LEGITIMATE upgrade, re-approve: this forgets
 * the pin, and the next session re-pins to whatever the server offers then.
 *
 * Explicit bootstrap forbids automatic approval, including a new prompt channel.
 * --approve-file reads local review material; approval writes stay under
 * CAIRN_HOME/trust. The digest binds the reviewed bytes, not reviewer identity.
 * Nothing leaves the machine.
 */
import fs from 'fs';
import path from 'path';
import { cairnHome } from '../src/lib/cairn/home';
import { readPin, forgetPin, approvePin, pinPath, trustBootstrap, type Pin } from '../src/lib/cairn/trust';
import { readLedger, type RetrievalRecord } from '../src/lib/cairn/ledger';

/**
 * The drift the GATEWAY recorded, per server. The CLI reads only pins (the
 * approved surface) and never talks to a live server, so it cannot compute
 * drift itself — but a running gateway writes every drift to the ledger as an
 * observation tagged `mcp-proxy:trust-<mode>`. Reading those back is how this
 * command surfaces "what changed since approval," which is the security event
 * the operator needs to see before deciding to re-approve or leave it blocked.
 */
function recordedDrift(): Map<string, { at: string; mode: string; detail: string }[]> {
  const byServer = new Map<string, { at: string; mode: string; detail: string }[]>();
  let rows: RetrievalRecord[] = [];
  try { rows = readLedger(); } catch { return byServer; }
  for (const r of rows) {
    const m = /^mcp-proxy:trust-(monitor|enforce)$/.exec(r.source ?? '');
    if (!m) continue;
    // The query is "<server> tool surface drifted from approval: <details>".
    const server = (r.query.split(' ')[0] || '').trim();
    if (!server) continue;
    const list = byServer.get(server) ?? [];
    list.push({ at: r.at, mode: m[1], detail: r.query });
    byServer.set(server, list);
  }
  for (const list of byServer.values()) list.sort((a, b) => b.at.localeCompare(a.at));
  return byServer;
}

const argv = process.argv.slice(2);
function opt(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : undefined;
}

let home: string;
try {
  home = cairnHome();
} catch {
  console.error('cairn:trust: no corpus home. Set CAIRN_HOME (e.g. ~/pilot).');
  process.exit(2);
}
const trustDir = path.join(home, 'trust');

const approveFile = opt('approve-file');
if (approveFile) {
  const server = opt('server');
  const digest = opt('sha256');
  if (!server || !digest) {
    console.error('cairn:trust: --approve-file requires --server and --sha256 of the reviewed file');
    process.exit(2);
  }
  try {
    const raw = fs.readFileSync(approveFile, 'utf8');
    if (!approvePin(server, raw, digest, trustDir)) throw new Error('digest or server/shape validation failed, or approval could not be saved');
    console.log(`cairn:trust — approved reviewed surface for "${server}" (sha256 ${digest}). Refresh the gateway listing or restart.`);
  } catch (error) {
    console.error(`cairn:trust: ${(error as Error).message}`);
    process.exit(2);
  }
  process.exit(0);
}

const drift = recordedDrift();

const reapprove = opt('reapprove');
if (reapprove) {
  if (trustBootstrap() === 'explicit') {
    console.error('cairn:trust: explicit approval does not use deletion. Import reviewed material with --approve-file --server --sha256.');
    process.exit(2);
  }
  // Show what the gateway saw drift BEFORE forgetting the pin. Re-approving is
  // trusting whatever the server offers next; the operator should decide that
  // against the actual change, not blind. If we recorded no drift, say so —
  // re-approving a surface that never drifted only resets the approval date.
  const events = drift.get(reapprove) ?? [];
  if (events.length) {
    console.log(`cairn:trust — recorded drift for "${reapprove}" (newest first), inspect before you re-approve:`);
    for (const e of events.slice(0, 5)) console.log(`  [${e.mode}] ${e.at}  ${e.detail.slice(0, 300)}`);
    console.log('');
  } else {
    console.log(`cairn:trust — no drift recorded for "${reapprove}" by any gateway run (re-approving only resets its approval date).`);
  }
  const ok = forgetPin(reapprove, trustDir);
  if (ok) {
    console.log(`cairn:trust — forgot the pin for "${reapprove}". Its next session re-pins to the surface it offers then.`);
    console.log('  Only do this once you have confirmed the change is a legitimate upgrade, not tampering.');
  } else {
    console.log(`cairn:trust — no pin for "${reapprove}" (nothing to re-approve).`);
  }
  process.exit(0);
}

/* Default: list the pins. */
let files: string[] = [];
try {
  files = fs.readdirSync(trustDir).filter((f) => f.endsWith('.json'));
} catch {
  /* no trust dir yet */
}
if (!files.length) {
  console.log('cairn:trust — no servers pinned yet.');
  console.log('  Explicit bootstrap requires --approve-file <file> --server <server> --sha256 <reviewed-digest>.');
  console.log('  TOFU bootstrap pins on first sight with CAIRN_TRUST_MODE monitor or enforce.');
  process.exit(0);
}
// Lead with the live security state: any server the gateway recorded as
// drifted is the thing to look at, before the roster of quiet pins.
const drifted = [...drift.keys()].sort();
if (drifted.length) {
  console.log(`cairn:trust — ⚠ ${drifted.length} server(s) drifted from approval (a gateway flagged or withheld a change):\n`);
  for (const server of drifted) {
    const events = drift.get(server) ?? [];
    const latest = events[0];
    const withheld = events.some((e) => e.mode === 'enforce');
    console.log(`  ${server.padEnd(20)} ${withheld ? 'WITHHELD (enforce)' : 'flagged (monitor)'}  latest ${latest?.at ?? ''}`);
    if (latest) console.log(`      ${latest.detail.slice(0, 200)}`);
  }
  console.log('\n  Inspect the change, then either re-approve it (if a legitimate upgrade) or leave it blocked (if tampering):');
  console.log('  cairn:trust --reapprove <server>\n');
} else {
  console.log('cairn:trust — no drift recorded: live surfaces were not checked by this command.\n');
}

console.log(`Pinned server(s) under ${trustDir}:\n`);
for (const f of files.sort()) {
  let server: string;
  try {
    server = JSON.parse(fs.readFileSync(path.join(trustDir, f), 'utf8')).server;
    if (typeof server !== 'string' || path.basename(pinPath(server, trustDir)) !== f) throw new Error('invalid server identity');
  } catch {
    console.log(`  ${f}  (unreadable pin)`);
    continue;
  }
  const pin: Pin | null = readPin(server, trustDir);
  if (!pin) { console.log(`  ${server}  (unreadable pin)`); continue; }
  const flag = drift.has(pin.server) ? '  ⚠ drifted' : '';
  // Prompts are pinned on their first complete listing; "not yet listed" is
  // distinct from "none", so an operator can see a channel that is still unapproved.
  const prompts = pin.prompts ? `, ${pin.prompts.length} prompt(s)` : ', prompts not yet listed';
  console.log(`  ${pin.server.padEnd(20)} ${pin.tools.length} tool(s)${prompts} approved ${pin.approvedAt}${flag}`);
}
console.log('\n  A tool or prompt whose definition drifts from its pin is flagged (monitor) or withheld (enforce).');
console.log('  Explicit bootstrap: --approve-file <file> --server <server> --sha256 <reviewed-digest>.');
console.log('  TOFU bootstrap: --reapprove <server> forgets approval for the next process.');
