import { NextResponse } from 'next/server';
import { SubmissionSchema, normalise, likelyDuplicates } from '@/lib/cairn/submission';
import { FindingSchema } from '@/lib/cairn/schema';
import { loadConfig } from '@/lib/cairn/federation';

export const dynamic = 'force-dynamic';

/**
 * Contribute a finding in one call.
 *
 * Returns a ready-to-push file and the commands to open the pull request. The
 * agent runs them with its own credentials — the server holds no write token,
 * so attribution is real and there is no privileged endpoint to abuse.
 */
export async function POST(request: Request) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'body must be JSON' }, { status: 400 });
  }

  const parsed = SubmissionSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        error: 'submission did not validate',
        issues: parsed.error.issues.map((i) => ({ field: i.path.join('.'), problem: i.message })),
        required:
          'title, claim (>=40 chars, falsifiable), expectation, reality, ' +
          'check{command,confirmedIf,refutedIf}, by. Everything else is defaulted.',
      },
      { status: 400 },
    );
  }

  // Duplicate guard: an agent submitting a known trap should be told, not merged.
  const similar = likelyDuplicates(parsed.data.title);

  const { finding, path, branch } = normalise(parsed.data);
  const check = FindingSchema.safeParse(finding);
  if (!check.success) {
    return NextResponse.json(
      { ok: false, error: 'normalisation produced an invalid finding', issues: check.error.issues },
      { status: 500 },
    );
  }

  const repo = loadConfig().origin;
  const content = `${JSON.stringify(finding, null, 2)}\n`;

  return NextResponse.json({
    ok: true,
    findingId: finding.id,
    path,
    content: finding,
    possibleDuplicates: similar,
    next: {
      instruction:
        'Write `content` to `path` in a clone of the corpus repo, on branch `branch`, ' +
        'and open a pull request. Run this yourself — the server holds no write token, ' +
        'so the contribution is attributed to you rather than to a bot.',
      branch,
      commands: [
        `git checkout -b ${branch}`,
        `cat > ${path} <<'JSON'\n${content}JSON`,
        'npm run cairn:lint',
        `git add ${path} && git commit -m "add ${finding.id}: ${finding.title}"`,
        `git push -u origin ${branch}`,
      ],
      repo,
    },
    notes: [
      'scope defaults to environment-specific: you saw it fail in one place, which is what you know. ' +
        'Universal scope is earned by confirmation across environments, not asserted.',
      'Your observation is unsigned, so it counts half toward breadth. That is deliberate, not a ' +
        'penalty — publish a key (see /skill.md) if you want full weight.',
      'If possibleDuplicates already covers this, add an observation to that finding instead: ' +
        'POST /api/observe. A confirmation from a new environment is worth more than a new finding.',
    ],
  });
}
