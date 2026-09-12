/**
 * cairn:project — give the repo you're in its own corpus, at <repo>/.cairn.
 *
 *   npm run cairn:project            # create .cairn/ in this git repo
 *   npm run cairn:project -- --from ~/pilot   # copy identity from a specific machine corpus
 *
 * WHY A PROJECT CORPUS. Most traps are about tools and belong in the machine
 * corpus, where a finding learned in one project helps the next. But some traps
 * are about THIS codebase, and those want to travel with the repo — committed, so
 * a teammate who clones it gets the knowledge and can confirm it under their own
 * key. That is also the cleanest path to a real second signer.
 *
 * COLLISION-SAFE BY CONSTRUCTION. The project corpus gets its own unique origin
 * (origin.ts), so its cairn-0001 and the machine's cairn-0001 are distinct
 * (<origin>:cairn-0001) and can never be confused — the exact defect that produced
 * the phantom finding. It reuses THIS machine's signing identity (copied in), so
 * you are the same author across both corpora rather than a new stranger per repo.
 *
 * The private key is copied into .cairn/.cairn-secrets and gitignored, so it never
 * travels with the repo; only the public key and the findings do.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { ensureOrigin } from '../src/lib/cairn/corpusOrigin';

const argv = process.argv.slice(2);
function opt(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : undefined;
}
const HOME = process.env.HOME || os.homedir();
const expand = (p: string) => (p.startsWith('~') ? path.join(HOME, p.slice(1)) : path.resolve(p));

/** The repo root (git top-level) of the current directory, or the cwd itself. */
function projectRoot(): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    return process.cwd();
  }
}

/** Where this machine's existing corpus lives, to borrow its identity from. */
function machineHome(): string | null {
  const explicit = opt('from');
  if (explicit) return expand(explicit);
  if (process.env.CAIRN_HOME) return process.env.CAIRN_HOME;
  const pilot = path.join(HOME, 'pilot');
  if (fs.existsSync(path.join(pilot, 'cairn'))) return pilot;
  const def = path.join(HOME, '.cairn', 'corpus');
  if (fs.existsSync(path.join(def, 'cairn'))) return def;
  return null;
}

/** Copy every file from src/ into dst/, creating dst. Returns how many copied. */
function copyDir(src: string, dst: string, mode?: number): number {
  if (!fs.existsSync(src)) return 0;
  // A DIRECTORY needs its execute bit or it cannot be entered — passing a file
  // mode like 0600 to mkdir made copyFileSync into it fail EACCES for any
  // non-root user. Give the dir 0700; files get `mode`.
  fs.mkdirSync(dst, { recursive: true, mode: mode ? 0o700 : undefined });
  let n = 0;
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    if (!fs.statSync(s).isFile()) continue;
    fs.copyFileSync(s, path.join(dst, name));
    if (mode) fs.chmodSync(path.join(dst, name), mode);
    n++;
  }
  return n;
}

function main(): void {
  const root = projectRoot();
  const home = path.join(root, '.cairn');
  console.log(`\ncairn:project — a corpus for ${root}`);
  console.log('='.repeat(60));

  fs.mkdirSync(path.join(home, 'cairn'), { recursive: true });
  const o = ensureOrigin(home);
  console.log(`  ${o.created ? 'created ' : 'present '}  corpus at ${home}  (origin "${o.origin}")`);

  /* Reuse this machine's identity so project findings are signed by you, not by a
   * new per-repo stranger. Copy public keys (committed) and private keys
   * (gitignored) from the machine corpus. */
  const mh = machineHome();
  if (mh) {
    const pub = copyDir(path.join(mh, 'keys'), path.join(home, 'keys'));
    const priv = copyDir(path.join(mh, '.cairn-secrets'), path.join(home, '.cairn-secrets'), 0o600);
    console.log(`  copied     ${pub} key(s) and ${priv} secret(s) from ${mh} — same identity, both corpora`);
  } else {
    console.log('  note       no machine corpus found to borrow an identity from; run cairn:install first,');
    console.log('             or this project corpus will need its own cairn:keygen before it can sign.');
  }

  const gi = path.join(home, '.gitignore');
  if (!fs.existsSync(gi)) {
    fs.writeFileSync(gi, '.cairn-secrets/\ndrafts/\n.cairn-cache/\nfederation/\nretrievals/\n');
    console.log(`  wrote      ${path.relative(root, gi)} (keeps private keys and caches out of git)`);
  }

  console.log('\n' + '='.repeat(60));
  console.log('This repo now has its own corpus. Its ids carry a unique origin, so they can');
  console.log('never be confused with the machine corpus or another repo\'s.');
  console.log('\nUse it for project-scoped work by pointing CAIRN_HOME at it:');
  console.log(`  CAIRN_HOME=${home} npm run cairn:find "<paste a failure>"`);
  console.log('\nCommit .cairn/ so the knowledge travels with the repo:');
  console.log('  git add .cairn && git commit -m "cairn: project corpus"');
  console.log('(.cairn-secrets stays out — your private key never leaves this machine.)\n');
}

main();
