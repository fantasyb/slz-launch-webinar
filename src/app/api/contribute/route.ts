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
 *   GATED BEFORE IT LANDS, not after. Schema, executable-content scan,
 *   injection scan, secret scan and duplicate detection all run here and
 *   reject before anything is committed. CI running afterwards is a report,
 *   not a gate.
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

  const { finding, path } = normalise(parsed.data);
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

  const body = `${JSON.stringify(check.data, null, 2)}\n`;
  if (DRY) {
    return NextResponse.json({ ok: true, dryRun: true, path, id: check.data.id, bytes: body.length });
  }

  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
    },
    /* No `sha`: the API creates, and refuses if the path already exists. */
    body: JSON.stringify({
      message: `add ${check.data.id}: ${check.data.title}`,
      content: Buffer.from(body).toString('base64'),
      branch: BRANCH,
    }),
  });

  if (!res.ok) {
    /* The upstream body can echo the request; never pass it through verbatim. */
    return NextResponse.json(
      { ok: false, error: `could not write the finding (${res.status})` },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true, id: check.data.id, path });
}
