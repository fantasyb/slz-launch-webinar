import { NextResponse } from 'next/server';
import { SubmissionSchema, normalise, likelyDuplicates } from '@/lib/cairn/submission';
import { FindingSchema } from '@/lib/cairn/schema';
import { scanExecutable, scanInjection, scanSensitive, draftSurface } from '@/lib/cairn/safety';

export const dynamic = 'force-dynamic';

/**
 * Contribute a finding and have it land, without write access to this repo.
 *
 * /api/submit deliberately writes nothing: it validates and hands back git
 * commands the submitter runs with their own credentials, so attribution is
 * real and there is no privileged endpoint to attack. That is the better
 * design and it requires every contributor to have push rights.
 *
 * When they cannot — no collaborator seats, and forking makes a reader stop
 * receiving other people's findings — the only remaining way for knowledge to
 * arrive is a service that writes on their behalf. This is that, built with
 * the smallest authority that still does the job, and the trade is stated
 * rather than hidden: a token that can write to the corpus now exists, and did
 * not before.
 *
 * WHAT BOUNDS THE DAMAGE
 *
 *   CREATE ONLY. It writes one new file under cairn/ and passes no blob sha,
 *   so the GitHub API refuses if the path exists. Nothing already recorded can
 *   be rewritten, and nothing outside cairn/ can be touched at all — not the
 *   ranker, not the workflows, not the keys.
 *
 *   ONTO A BRANCH, AS A PULL REQUEST. It never writes to the default branch.
 *   This was a direct write to main, which meant the one path that accepts
 *   findings from people with no push rights was also the one path that
 *   skipped cairn-review.yml — it triggers on `pull_request` — and skipped
 *   the human merge the README credits for making hostile content hard to
 *   land. Now the automated review and the merge both apply where they
 *   matter most.
 *
 *   GATED BEFORE IT LANDS, not after. Schema, executable-content scan,
 *   injection scan, secret scan and duplicate detection all run here and
 *   reject before a branch is even created. CI on the pull request is a
 *   second, independent layer rather than the only one.
 *
 *   A BAD FINDING IS SURVIVABLE. Findings are retired rather than deleted,
 *   confidence rises with independent attesters, and a claim nobody re-runs
 *   decays. One wrong record is the failure mode this corpus is built to
 *   absorb. A rewritten history is not, which is why the write is create-only.
 *
 * The token is never returned, never logged, and never reaches the response.
 */

const REPO = process.env.CAIRN_REPO;
const BRANCH = process.env.CAIRN_BRANCH ?? 'main';
const TOKEN = process.env.CAIRN_GITHUB_TOKEN;
/* Verifies the whole path except the network call, so it is testable offline. */
const DRY = process.env.CAIRN_CONTRIBUTE_DRYRUN === '1';

/**
 * The ids the LIVE corpus already uses, read from the repository itself.
 *
 * nextFindingId() reads the corpus this process has on disk. On a deployed
 * server that directory is whatever was bundled at build time, and
 * loadCorpus() memoises it for the process lifetime -- so it does not
 * advance when a finding lands, and two submissions minted the same
 * cairn-NNNN under different slugs. The create-only guard is on the PATH, so
 * GitHub accepted both happily, and every clone then failed to load at all
 * with "duplicate id". One careless contributor broke the corpus for
 * everybody, which is the one failure mode the create-only design was
 * supposed to rule out.
 *
 * Listing costs one request against a directory of small files and is the
 * only source of truth that is actually current.
 */
async function liveNumbersInUse(): Promise<Set<number>> {
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/contents/cairn?ref=${encodeURIComponent(BRANCH)}`,
    {
      headers: {
        authorization: `Bearer ${TOKEN}`,
        accept: 'application/vnd.github+json',
      },
      cache: 'no-store',
    },
  );
  if (!res.ok) throw new Error(`could not read the live corpus (${res.status})`);
  const entries = (await res.json()) as { name?: string; type?: string }[];
  const used = new Set<number>();
  for (const e of entries) {
    if (e.type !== 'file' || !e.name?.endsWith('.json')) continue;
    const n = parseInt(e.name.slice(0, 4), 10);
    if (Number.isFinite(n)) used.add(n);
  }
  return used;
}

export async function POST(request: Request) {
  if (!TOKEN && !DRY) {
    return NextResponse.json(
      { ok: false, error: 'contribution is not enabled on this host' },
      { status: 501 },
    );
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'body must be JSON' }, { status: 400 });
  }

  const parsed = SubmissionSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'invalid submission', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  /*
   * Scanned before anything else looks at it. Evidence is error output, and
   * error output carries hostnames, home paths and tokens — the submitter may
   * not have noticed, and once it is committed it is in everybody's clone.
   */
  const surface = draftSurface(parsed.data as Record<string, unknown>);
  const flags = [
    ...scanExecutable(surface),
    ...scanInjection(surface),
    ...scanSensitive(surface),
  ];
  if (flags.length) {
    return NextResponse.json(
      {
        ok: false,
        error: 'refused: the submission contains content that must not be committed',
        flags,
      },
      { status: 422 },
    );
  }

  /*
   * Minted from the live repository, never from this process's copy. In dry
   * run there is no repository to ask, so the local corpus stands in -- that
   * is the one path where a stale id is harmless, because nothing is written.
   */
  let mintedId: string | undefined;
  if (!DRY) {
    try {
      const used = await liveNumbersInUse();
      /*
       * max + 1, never the lowest free number. A gap in the sequence means a
       * finding was moved or promoted, not that its id is available, and
       * reusing it points every existing reference at a different claim.
       */
      const next = Math.max(0, ...used) + 1;
      mintedId = `cairn-${String(next).padStart(4, '0')}`;
    } catch {
      return NextResponse.json(
        { ok: false, error: 'could not read the live corpus to allocate an id' },
        { status: 503 },
      );
    }
  }

  const { finding, path, branch } = normalise(parsed.data, new Date(), mintedId);
  const check = FindingSchema.safeParse(finding);
  if (!check.success) {
    return NextResponse.json(
      { ok: false, error: 'normalisation produced an invalid finding', issues: check.error.issues },
      { status: 400 },
    );
  }

  /*
   * Duplicates are refused rather than merged. Absorbing one automatically
   * would rewrite an existing record, which is exactly the authority this
   * endpoint does not have — and a wrong merge silently loses a real finding.
   * The submitter is told which record to add an observation to instead.
   */
  const dupes = likelyDuplicates(check.data.title);
  if (dupes.length) {
    return NextResponse.json(
      {
        ok: false,
        error: 'already recorded — add an observation to the existing finding instead',
        duplicates: dupes.map((d) => ({ id: d.id, title: d.title })),
      },
      { status: 409 },
    );
  }

  /*
   * Two submissions arriving together still both read the same free number,
   * and their paths differ by slug, so create-only does not separate them.
   * That window is narrow and it is not closed here: closing it needs a
   * mutex this endpoint has no authority to take. What is closed is the
   * guaranteed case -- a frozen or memoised corpus minting the same id every
   * time -- and a collision that does slip through is caught by lint before
   * it can be believed, rather than silently.
   */
  const body = `${JSON.stringify(check.data, null, 2)}\n`;
  if (DRY) {
    return NextResponse.json({ ok: true, dryRun: true, path, branch, id: check.data.id, bytes: body.length });
  }

  /*
   * Onto a branch, then a pull request -- never straight onto the default
   * branch.
   *
   * cairn-review.yml triggers on `pull_request` only, so a direct write to
   * main skipped every automated reviewer AND the human merge, while the
   * README went on advertising "two independent layers in CI, plus a human
   * merge" as what makes hostile content hard to land. For the one path that
   * accepts findings from people with no write access -- the only path where
   * that defence actually matters -- it was not true.
   *
   * It also makes the id collision above survivable: a duplicate id now
   * fails corpus lint on the pull request, where somebody can fix it, rather
   * than landing on main and breaking every clone on their next sync.
   */
  const gh = (p: string, init: RequestInit = {}) =>
    fetch(`https://api.github.com/repos/${REPO}${p}`, {
      ...init,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
      },
      cache: 'no-store',
    });

  const baseRef = await gh(`/git/ref/heads/${encodeURIComponent(BRANCH)}`);
  if (!baseRef.ok) {
    return NextResponse.json(
      { ok: false, error: `could not read the base branch (${baseRef.status})` },
      { status: 502 },
    );
  }
  const baseSha = ((await baseRef.json()) as { object: { sha: string } }).object.sha;

  const made = await gh('/git/refs', {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
  });
  if (!made.ok && made.status !== 422) {
    return NextResponse.json(
      { ok: false, error: `could not open a branch (${made.status})` },
      { status: 502 },
    );
  }

  const written = await gh(`/contents/${path}`, {
    method: 'PUT',
    /* No `sha`: the API creates, and refuses if the path already exists. */
    body: JSON.stringify({
      message: `add ${check.data.id}: ${check.data.title}`,
      content: Buffer.from(body).toString('base64'),
      branch,
    }),
  });
  if (!written.ok) {
    /* The upstream body can echo the request; never pass it through verbatim. */
    return NextResponse.json(
      { ok: false, error: `could not write the finding (${written.status})` },
      { status: 502 },
    );
  }

  const pr = await gh('/pulls', {
    method: 'POST',
    body: JSON.stringify({
      title: `${check.data.id}: ${check.data.title}`,
      head: branch,
      base: BRANCH,
      body:
        `Submitted through \`/api/contribute\` by \`${check.data.observations[0].by}\`.\n\n` +
        'Schema, executable-content, injection, secret and duplicate checks passed ' +
        'before this branch was created. Corpus lint and the review workflow run here.',
    }),
  });
  if (!pr.ok) {
    /* The finding is on a branch and recoverable by hand; say so rather than
     * reporting a clean failure the submitter would retry into a duplicate. */
    return NextResponse.json(
      { ok: false, error: `written to ${branch}, but could not open a pull request`, branch },
      { status: 502 },
    );
  }
  const url = ((await pr.json()) as { html_url?: string }).html_url;
  return NextResponse.json({ ok: true, id: check.data.id, path, branch, pullRequest: url });
}
