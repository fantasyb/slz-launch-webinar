/**
 * cairn:update — bring the code checkout up to its pin, safely, on demand.
 *
 *   npm run cairn:update                 # fast-forward origin/<current branch>, rebuild
 *   npm run cairn:update -- --branch main
 *   npm run cairn:update -- --remote upstream --branch main
 *   npm run cairn:update -- --check      # say what would happen; change nothing
 *   npm run cairn:update -- --json
 *
 * This is the manual trigger behind `/cairn update`, and the same code the
 * daemon runs unattended (src/lib/cairn/selfUpdate.ts). It is fast-forward only,
 * clean-tree only, pinned-remote only, and rolls back if the new code does not
 * build — so running it can never discard your work or leave a broken checkout.
 *
 * It updates the CODE, not the corpus. `cairn:sync` pulls the shared findings;
 * this pulls the program that serves them.
 */
import { selfUpdate, describeUpdate, repoRoot } from '../src/lib/cairn/selfUpdate';

const argv = process.argv.slice(2);
function opt(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
}
const asJson = argv.includes('--json');
const checkOnly = argv.includes('--check');

const repoDir = repoRoot();
const result = selfUpdate({
  repoDir,
  remote: opt('remote'),
  branch: opt('branch'),
  dryRun: checkOnly,
});

if (asJson) {
  console.log(JSON.stringify({ repoDir, ...result }, null, 2));
} else {
  console.log(`cairn:update — ${describeUpdate(result)}`);
  if (result.status === 'updated') console.log('  The daemon reloads on its next self-update tick, or restart it to run the new code now.');
  if (result.status === 'skipped' && /local changes/.test(result.reason ?? '')) {
    console.log('  Commit or stash your changes first; the updater never discards them.');
  }
}

/* A rolled-back or failed update is a non-zero exit so a script that chains on
 * it stops; up-to-date, updated and a clean skip are all exit 0. */
process.exit(result.status === 'failed' || result.status === 'rolled-back' ? 1 : 0);
