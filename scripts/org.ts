/**
 * cairn:org — provision the enterprise gateway's access policy.
 *
 *   CAIRN_HOME=~/pilot npm run cairn:org -- init-policy [--require-auth]
 *   CAIRN_HOME=~/pilot npm run cairn:org -- mint-token --id alice --role readonly
 *   CAIRN_HOME=~/pilot npm run cairn:org -- list
 *   CAIRN_HOME=~/pilot npm run cairn:org -- revoke --id alice
 *
 * The policy lives at CAIRN_HOME/org-policy.json (or $CAIRN_ORG_POLICY). It is
 * what turns the personal loopback gateway into a governed one: while it is
 * absent, every client is the local admin and nothing is gated; once it exists
 * and requires auth, a client must present a bearer token that maps to a
 * principal, and that principal's role decides which servers and tools it may
 * reach.
 *
 * A token is shown ONCE, here, on the machine that minted it. The policy stores
 * only its SHA-256 — never the raw secret — so the committed/synced policy file
 * cannot be replayed as a credential. Hand the printed token to the client out
 * of band (a secrets manager, not chat, not the repo).
 */
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { cairnHome } from '../src/lib/cairn/home';
import { orgPolicyPath, loadOrgPolicy, tokenHash, type OrgPolicy, type Role } from '../src/lib/cairn/enterprise';

const argv = process.argv.slice(2);
const cmd = argv[0];
function opt(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : undefined;
}
const has = (name: string) => argv.includes(`--${name}`);

function policyFile(): string {
  if (process.env.CAIRN_ORG_POLICY) return process.env.CAIRN_ORG_POLICY;
  return path.join(cairnHome(), 'org-policy.json');
}

/** Write the policy atomically (tmp + rename), pretty-printed. */
function writePolicy(policy: OrgPolicy): void {
  const p = policyFile();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = path.join(path.dirname(p), `.org-policy.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(policy, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, p);
}

function die(msg: string, code = 1): never {
  console.error(`cairn:org: ${msg}`);
  process.exit(code);
}

let home: string;
try { home = cairnHome(); } catch { die('no corpus home. Set CAIRN_HOME (e.g. ~/pilot).', 2); }

if (cmd === 'init-policy') {
  const p = policyFile();
  if (fs.existsSync(p)) die(`a policy already exists at ${p} — edit it or mint tokens against it, do not re-init (that would drop every principal).`);
  const policy: OrgPolicy = {
    auth: { required: has('require-auth') },
    principals: {},
    roles: {
      // A starter set. Edit freely: allowServers/denyServers/denyTools/readTools/readOnly/readOnlyStrict.
      admin: {},
      readonly: { readOnly: true },
    },
  };
  writePolicy(policy);
  console.log(`cairn:org — wrote ${p}`);
  console.log(`  auth required: ${policy.auth.required}${policy.auth.required ? '' : '  (set --require-auth, or edit auth.required, to actually gate access)'}`);
  console.log('  roles: admin (unrestricted), readonly (write-looking tools denied)');
  console.log('  Next: cairn:org mint-token --id <who> --role <role>');
  process.exit(0);
}

if (cmd === 'mint-token') {
  const id = opt('id');
  const role = opt('role');
  if (!id || !role) die('mint-token needs --id <principalId> and --role <role>.');
  const policy = loadOrgPolicy();
  if (!policy) die(`no policy at ${policyFile()} — run: cairn:org init-policy --require-auth`);
  if (!policy.roles[role]) die(`role "${role}" is not defined in the policy (roles: ${Object.keys(policy.roles).join(', ') || 'none'}). Add it to org-policy.json first.`);
  // 256 bits of entropy, url-safe. Shown once; only its hash is persisted.
  const token = randomBytes(32).toString('base64url');
  const hash = tokenHash(token);
  if (policy.principals[hash]) die('token collision (astronomically unlikely) — run mint-token again.');
  policy.principals[hash] = { id, role };
  writePolicy(policy);
  console.log(`cairn:org — minted a token for "${id}" (role ${role}).`);
  console.log('  Only the hash is kept in the policy; the raw token is shown ONCE, now:\n');
  console.log(`    ${token}\n`);
  console.log('  Give it to the client as an Authorization: Bearer header, out of band.');
  console.log('  It cannot be recovered — mint a new one (and revoke this) if it is lost.');
  process.exit(0);
}

if (cmd === 'revoke') {
  const id = opt('id');
  if (!id) die('revoke needs --id <principalId>.');
  const policy = loadOrgPolicy();
  if (!policy) die(`no policy at ${policyFile()}.`);
  const before = Object.keys(policy.principals).length;
  for (const [hash, pr] of Object.entries(policy.principals)) if (pr.id === id) delete policy.principals[hash];
  const removed = before - Object.keys(policy.principals).length;
  if (!removed) die(`no principal with id "${id}" (nothing revoked).`);
  writePolicy(policy);
  console.log(`cairn:org — revoked ${removed} token(s) for "${id}". A running gateway drops them on its next request (policy is re-read on change).`);
  process.exit(0);
}

if (cmd === 'list' || cmd === undefined) {
  const policy = loadOrgPolicy();
  if (!policy) {
    console.log(`cairn:org — no policy at ${policyFile()} (this gateway is ungoverned: every client is the local admin).`);
    console.log('  Create one with:  cairn:org init-policy --require-auth');
    process.exit(0);
  }
  console.log(`cairn:org — policy at ${policyFile()}`);
  console.log(`  auth required: ${policy.auth.required}\n`);
  const roles = Object.entries(policy.roles);
  console.log(`  roles (${roles.length}):`);
  for (const [name, r] of roles) console.log(`    ${name.padEnd(14)} ${describeRole(r)}`);
  const principals = Object.values(policy.principals);
  console.log(`\n  principals (${principals.length}):`);
  if (!principals.length) console.log('    (none — mint one: cairn:org mint-token --id <who> --role <role>)');
  for (const pr of principals) console.log(`    ${pr.id.padEnd(20)} role ${pr.role}`);
  console.log('\n  Tokens are never stored or shown — only their hashes live in the policy.');
  process.exit(0);
}

die(`unknown command "${cmd}". Use: init-policy | mint-token | revoke | list`);

function describeRole(r: Role): string {
  const parts: string[] = [];
  if (r.readOnlyStrict) parts.push('strict read-only');
  else if (r.readOnly) parts.push('read-only');
  if (r.allowServers?.length) parts.push(`servers: ${r.allowServers.join(', ')}`);
  if (r.denyServers?.length) parts.push(`deny servers: ${r.denyServers.join(', ')}`);
  if (r.denyTools?.length) parts.push(`deny tools: ${r.denyTools.join(', ')}`);
  // Shown so an operator reviewing the policy sees every place the read/write
  // classifier has been overruled — the override is a governance decision.
  if (r.readTools?.length) parts.push(`treated as reads (override): ${r.readTools.join(', ')}`);
  return parts.length ? parts.join('; ') : 'unrestricted';
}
