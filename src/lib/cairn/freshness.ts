/**
 * How out of date is the corpus you are holding?
 *
 * A clone is a snapshot. Somebody records a finding tomorrow and your checkout
 * does not know it exists until you pull — and until now nothing ever said so.
 * The CLI answered from a three-week-old corpus in exactly the tone it uses for
 * a current one, which is the same failure as answering from a corpus that
 * failed to load: reporting the consequence of not having looked as knowledge.
 *
 * THREE DIFFERENT FACTS, and only the last one is what a reader wants:
 *
 *   1. when the corpus last CHANGED — cheap, and nearly meaningless. A ledger
 *      nobody has touched in a month may be complete; one you cloned a month
 *      ago with thirty commits since is not.
 *   2. how far BEHIND the remote you are — the real question, but it needs the
 *      remote-tracking ref, which is only as current as your last fetch.
 *   3. WHEN YOU LAST FETCHED — because "0 commits behind" from a ref you last
 *      updated in July is not reassurance, it is ignorance with a number on it.
 *
 * All of it is local. No network in the lookup path: this runs inside somebody
 * else's debugging loop, at the moment they are already stuck, and a tool that
 * pauses there to talk to a server has misunderstood its job.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { cairnHome } from './home';

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: cairnHome(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Where new knowledge comes FROM, which on a fork is not where you push.
 *
 * A fork's origin is your own copy: it never receives anybody else's findings,
 * so measuring "behind" against it always says zero and always will. The
 * corpus you want is upstream. Prefer that remote when it exists, which is
 * also the shape git itself expects for this.
 */
export function knowledgeRemote(): string | null {
  const remotes = git(['remote']);
  if (remotes && remotes.split('\n').includes('upstream')) return 'upstream';
  const tracked = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  return tracked ? tracked.split('/')[0] : null;
}

/** The ref new findings arrive on: upstream's branch when forked, else the tracked one. */
function knowledgeRef(): string | null {
  const remote = knowledgeRemote();
  if (!remote) return null;
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (remote === 'upstream' && branch) {
    const ref = `upstream/${branch}`;
    if (git(['rev-parse', '--verify', '--quiet', ref]) !== null) return ref;
    /* Forks often track a differently-named default branch. */
    const head = git(['symbolic-ref', '--short', 'refs/remotes/upstream/HEAD']);
    if (head) return head;
  }
  return git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
}

export interface Freshness {
  /** Commits on the tracked remote branch that this checkout does not have. */
  behind: number | null;
  /** Days since the remote-tracking ref was last updated, i.e. since a fetch. */
  sinceFetchDays: number | null;
  /** Days since the corpus directory itself last changed here. */
  corpusAgeDays: number | null;
}

const DAY = 86_400_000;

export function freshness(): Freshness {
  const ref = knowledgeRef();
  const behindRaw = ref ? git(['rev-list', '--count', `HEAD..${ref}`]) : null;
  const changed = git(['log', '-1', '--format=%ct', '--', 'cairn']);

  /*
   * FETCH_HEAD's mtime is when the last fetch actually happened. The
   * remote-tracking ref's own commit date is not: it is when somebody else
   * committed, which can be months before you learned about it.
   */
  let sinceFetchDays: number | null = null;
  try {
    const gitDir = git(['rev-parse', '--git-dir']);
    if (gitDir) {
      const abs = path.isAbsolute(gitDir) ? gitDir : path.join(cairnHome(), gitDir);
      sinceFetchDays = (Date.now() - fs.statSync(path.join(abs, 'FETCH_HEAD')).mtimeMs) / DAY;
    }
  } catch {
    sinceFetchDays = null;
  }

  return {
    behind: behindRaw === null ? null : Number(behindRaw),
    sinceFetchDays,
    corpusAgeDays: changed ? (Date.now() - Number(changed) * 1000) / DAY : null,
  };
}

/**
 * One line, or nothing. Silence is the common case: a checkout that is current
 * should not spend a reader's attention telling them so.
 */
export function stalenessNote(f: Freshness = freshness()): string | null {
  const days = (n: number) => (n < 1 ? 'today' : n < 2 ? '1 day ago' : `${Math.floor(n)} days ago`);

  if (f.behind !== null && f.behind > 0) {
    return `${f.behind} finding commit${f.behind === 1 ? '' : 's'} behind. Run: npm run cairn:sync`;
  }
  /* Never fetched, or not fetched in a fortnight: the zero above means nothing. */
  if (f.sinceFetchDays === null || f.sinceFetchDays > 14) {
    const when = f.sinceFetchDays === null ? 'never' : days(f.sinceFetchDays);
    return `You have not checked for new findings (last fetch: ${when}). Run: npm run cairn:sync`;
  }
  return null;
}
