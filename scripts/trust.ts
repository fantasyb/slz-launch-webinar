/**
 * cairn:trust — see and manage the gateway's trust pins.
 *
 *   CAIRN_HOME=~/pilot npm run cairn:trust                       # list pinned servers
 *   CAIRN_HOME=~/pilot npm run cairn:trust -- --reapprove <srv>  # accept its CURRENT surface
 *
 * A pin is the approved tool surface of a wrapped MCP server — every tool's name,
 * description, annotations, and schema hash, as it was when first seen. The
 * gateway pins each server on first sight; in enforce mode it withholds any tool
 * whose definition later changed (the tool-poisoning / rug-pull defense) until it
 * is re-approved. When a change is a LEGITIMATE upgrade, re-approve: this forgets
 * the pin, and the next session re-pins to whatever the server offers then.
 *
 * Reads and writes only under CAIRN_HOME/trust. Nothing leaves the machine.
 */
import fs from 'fs';
import path from 'path';
import { cairnHome } from '../src/lib/cairn/home';
import { readPin, forgetPin, type Pin } from '../src/lib/cairn/trust';

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

const reapprove = opt('reapprove');
if (reapprove) {
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
  console.log('  A wrapped server is pinned on its first session (with CAIRN_TRUST_MODE monitor or enforce).');
  process.exit(0);
}
console.log(`cairn:trust — ${files.length} pinned server(s) under ${trustDir}\n`);
for (const f of files.sort()) {
  const server = path.basename(f, '.json');
  const pin: Pin | null = readPin(server, trustDir);
  if (!pin) { console.log(`  ${server}  (unreadable pin)`); continue; }
  console.log(`  ${pin.server.padEnd(20)} ${pin.tools.length} tool(s) approved ${pin.approvedAt}`);
}
console.log('\n  A tool whose definition drifts from its pin is flagged (monitor) or withheld (enforce).');
console.log('  Re-approve a legitimate change with:  cairn:trust --reapprove <server>');
