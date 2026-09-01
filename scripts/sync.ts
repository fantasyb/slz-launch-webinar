/**
 * cairn:sync — go and see what other people have recorded.
 *
 *   npm run cairn:sync
 *
 * A clone is a snapshot. Somebody records a finding an hour after you cloned
 * and your checkout does not know it exists. Nothing in this project ever said
 * so: it answered from a month-old corpus in the same tone it uses for a
 * current one.
 *
 * The lookup path stays offline on purpose — it runs inside somebody else's
 * debugging loop and must not pause to talk to a server — so freshness is a
 * separate, deliberate act. This is it.
 */
import { execFileSync } from 'child_process';
import { cairnHome } from '../src/lib/cairn/home';
import { loadCorpus } from '../src/lib/cairn/load';

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: cairnHome(), encoding: 'utf8' }).trim();
}

const before = new Set(loadCorpus().map((f) => f.id));
const head = git(['rev-parse', 'HEAD']);

console.log(`\n  fetching ${cairnHome()}`);
try {
  git(['pull', '--rebase', '--autostash']);
} catch (e) {
  console.error('\n  pull failed. Your own findings are safe; resolve and re-run.\n');
  console.error(String((e as Error).message).split('\n').slice(0, 6).join('\n'));
  process.exit(1);
}

/* The index is keyed on a corpus fingerprint, so new findings must rebuild it. */
try {
  execFileSync('npm', ['run', 'cairn:build-cli'], { cwd: cairnHome(), stdio: 'ignore' });
} catch {
  /* The launcher falls back to tsx; slow, correct. */
}

/*
 * Deliberately re-read from disk rather than trusting the count: the point of
 * this command is to tell you what ARRIVED, and a number without names is not
 * something anyone reads.
 */
delete require.cache[require.resolve('../src/lib/cairn/load')];
const after = (await import('../src/lib/cairn/load')).loadCorpus();
const fresh = after.filter((f) => !before.has(f.id));

if (git(['rev-parse', 'HEAD']) === head && fresh.length === 0) {
  console.log('  already current — nothing new.\n');
} else {
  console.log(`  ${after.length} findings (${fresh.length} new)\n`);
  for (const f of fresh) console.log(`    ${f.id}  ${f.title}`);
  if (fresh.length) console.log('');
}
