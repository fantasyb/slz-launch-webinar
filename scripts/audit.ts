/**
 * Audits the prediction ledger against git history.
 *
 * A commitment proves the forecast was not edited. Git proves WHEN it was
 * published. Together they establish that the seal entered public history
 * before the reveal that resolved it — which is the claim the whole ledger
 * rests on, and which anyone can now check without trusting us.
 *
 *   npm run cairn:audit
 */
import { execFileSync } from 'child_process';
import { loadCorpus } from '../src/lib/cairn/load';
import { allPredictions } from '../src/lib/cairn/calibration';

function firstCommitContaining(needle: string): string | null {
  try {
    // execFileSync, never execSync: `needle` is a commitment hash or nonce
    // taken verbatim from contributor JSON, and this script runs in CI on
    // every pull request. Interpolating it into a shell string handed any
    // contributor arbitrary command execution on a runner holding the
    // provider API keys — the one script whose entire job is adjudicating
    // untrusted data was passing it to a shell.
    const out = execFileSync(
      'git',
      ['log', '--format=%H', '--reverse', `-S${needle}`, '--', 'cairn/'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return out.split('\n')[0] || null;
  } catch {
    return null;
  }
}

function isAncestor(a: string, b: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', a, b], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

let failures = 0;
let legacy = 0;
let audited = 0;

for (const p of allPredictions(loadCorpus())) {
  const label = `${p.findingId} by ${p.by}`;

  if (p.status === 'unanchored') {
    console.log(`skip   ${label} — unanchored, not scored`);
    continue;
  }
  if (p.status === 'broken') {
    console.error(`FAIL   ${label} — commitment does not recompute`);
    failures++;
    continue;
  }
  if (p.status === 'legacy-encoding') {
    // The git ancestry below would still pass for these, and reporting them
    // among the provably-sealed would overstate what they establish: the v1
    // encoding was not prefix-free, so the hash fixes WHEN the seal was made
    // and not WHAT it said.
    console.log(`skip   ${label} — v1 encoding, ordering provable but content is not`);
    legacy++;
    continue;
  }
  if (!p.commitment) continue;

  const sealCommit = firstCommitContaining(p.commitment.hash);
  if (!sealCommit) {
    console.log(`pend   ${label} — seal not yet in committed history`);
    continue;
  }

  // The anchor must precede the seal: you cannot commit to a future HEAD.
  if (!isAncestor(p.commitment.anchor, sealCommit)) {
    console.error(`FAIL   ${label} — anchor ${p.commitment.anchor.slice(0, 8)} is not an ancestor of the seal`);
    failures++;
    continue;
  }

  if (p.status === 'sealed') {
    console.log(`sealed ${label} — awaiting reveal, seal at ${sealCommit.slice(0, 8)}`);
    continue;
  }

  const revealCommit = p.nonce ? firstCommitContaining(p.nonce) : null;
  if (!revealCommit) {
    console.log(`pend   ${label} — reveal not yet committed`);
    continue;
  }
  if (revealCommit === sealCommit) {
    console.error(`FAIL   ${label} — seal and reveal in the same commit; the ordering proves nothing`);
    failures++;
    continue;
  }
  if (!isAncestor(sealCommit, revealCommit)) {
    console.error(`FAIL   ${label} — seal is not an ancestor of the reveal`);
    failures++;
    continue;
  }

  audited++;
  console.log(
    `ok     ${label} — sealed ${sealCommit.slice(0, 8)} -> revealed ${revealCommit.slice(0, 8)}`,
  );
}

console.log(
  `\n${audited} forecast(s) provably sealed before resolution · ${failures} failure(s)` +
    (legacy > 0 ? ` · ${legacy} under the superseded v1 encoding, not counted` : ''),
);
process.exit(failures > 0 ? 1 : 0);
