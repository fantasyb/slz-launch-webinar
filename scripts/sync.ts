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
import { cairnHome, installRoot } from '../src/lib/cairn/home';
import { loadConfig } from '../src/lib/cairn/federation';
import { knowledgeRemote } from '../src/lib/cairn/freshness';
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

/*
 * A personal corpus is a directory, not necessarily a clone.
 *
 * SETUP.md tells a second user to `mkdir ~/my-cairn` and point it at an
 * upstream. Every git call below then failed, and the first one failed
 * OUTSIDE any try -- so the documented flow for the second person to ever
 * use this ended in a raw node stack trace reading "fatal: not a git
 * repository". The freshness that matters to that user is federation, which
 * needs no git at all.
 */
function isGitRepo(): boolean {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: cairnHome(), stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const tracked = isGitRepo();
const before = new Set(loadCorpus().map((f) => f.id));
const head = tracked ? git(['rev-parse', 'HEAD']) : '';

/*
 * Pull from where knowledge ARRIVES, not from where you push.
 *
 * On a fork those are different places, and the difference is the whole point:
 * origin is your own copy and will never contain anybody else's findings, so
 * syncing against it succeeds, reports nothing new, and is worthless forever.
 */
if (tracked) {
  const remote = knowledgeRemote() ?? 'origin';
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  console.log(`\n  fetching ${cairnHome()} from ${remote}`);
  try {
    git(['pull', '--rebase', '--autostash', remote, branch]);
  } catch (e) {
    console.error('\n  pull failed. Your own findings are safe; resolve and re-run.\n');
    console.error(String((e as Error).message).split('\n').slice(0, 6).join('\n'));
    process.exit(1);
  }
} else {
  console.log(`\n  ${cairnHome()} is not a git checkout — federating only`);
}

/*
 * Sync means "go and see what other people have recorded", and for anyone
 * keeping their own corpus that knowledge arrives by FEDERATION, not by git.
 * This step was missing entirely: a personal corpus subscribed to an upstream
 * pulled from it exactly once, by hand, and every later sync reported
 * "already current" while the upstream moved on without it.
 *
 * npm runs from the install, never from the corpus: a personal corpus has no
 * package.json, so the previous `cwd: cairnHome()` resolved no script and the
 * catch swallowed it. CAIRN_HOME is inherited, so the work still lands in the
 * caller's own corpus.
 */
const root = installRoot();
if (root) {
  if (loadConfig().upstreams.length > 0) {
    try {
      execFileSync('npm', ['run', 'cairn:federate'], { cwd: root, stdio: 'ignore' });
    } catch {
      console.error('  federation refresh failed; your local findings are unaffected.');
    }
  }

  /* The index is keyed on a corpus fingerprint, so new findings must rebuild it. */
  try {
    execFileSync('npm', ['run', 'cairn:build-cli'], { cwd: root, stdio: 'ignore' });
  } catch {
    /* The launcher falls back to tsx; slow, correct. */
  }
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

if ((!tracked || git(['rev-parse', 'HEAD']) === head) && fresh.length === 0) {
  console.log('  already current — nothing new.\n');
} else {
  console.log(`  ${after.length} findings (${fresh.length} new)\n`);
  for (const f of fresh) console.log(`    ${f.id}  ${f.title.slice(0, 68)}`);
  if (fresh.length) console.log('');
}
