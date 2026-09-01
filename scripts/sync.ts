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
import fs from 'fs';
import path from 'path';
import { loadCorpus } from '../src/lib/cairn/load';

/*
 * The id from the FILE, not from the filename. The first version sliced the
 * first ten characters of the name — "0036-a-pgr" — and compared it against
 * ids like "cairn-0036", so nothing ever matched and every sync announced the
 * entire corpus as new. A comparison between two things that are never equal
 * reports the same way as a genuine change.
 */
function readFinding(file: string): { id: string; title: string } {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { id?: string; title?: string };
    return { id: j.id ?? file, title: j.title ?? '' };
  } catch {
    return { id: file, title: '' };
  }
}

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
 * Read the directory rather than re-importing the loader. The first version
 * cleared require.cache and re-imported, which dies as ERR_REQUIRE_ASYNC_MODULE
 * once the file is transpiled — a command nobody had run, shipped broken. The
 * ids are in the filenames; there is no reason to involve a module system.
 */
const after = fs
  .readdirSync(path.join(cairnHome(), 'cairn'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => readFinding(path.join(cairnHome(), 'cairn', f)));
const fresh = after.filter((f) => !before.has(f.id));

if (git(['rev-parse', 'HEAD']) === head && fresh.length === 0) {
  console.log('  already current — nothing new.\n');
} else {
  console.log(`  ${after.length} findings (${fresh.length} new)\n`);
  for (const f of fresh) console.log(`    ${f.id}  ${f.title.slice(0, 68)}`);
  if (fresh.length) console.log('');
}
