import { NextResponse } from 'next/server';
import { SubmissionSchema, normalise, likelyDuplicates } from '@/lib/cairn/submission';
import { FindingSchema } from '@/lib/cairn/schema';
import { loadConfig } from '@/lib/cairn/federation';
import { scanExecutable, scanInjection, scanSensitive, draftSurface } from '@/lib/cairn/safety';

export const dynamic = 'force-dynamic';

/**
 * Contribute a finding.
 *
 * This endpoint is for someone who has DECIDED to publish — not for an agent
 * calling it mid-task from a repository it is working in. Evidence is error
 * output, and error output carries internal hostnames, home paths and tokens;
 * that decision belongs to a person who knows what is sensitive there. The
 * installed block therefore tells agents to draft locally and stop, and points
 * here only for whoever makes the call.
 *
 * Nothing is written server-side. It validates, scans, normalises, and returns
 * a ready-to-push file plus the git commands, which the submitter runs with
 * their own credentials — so attribution is real and no privileged endpoint
 * exists to attack.
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

  // The corpus is executed by agents. Refuse to mint a finding that carries a
  // fetch-and-execute or credential-reading command, whatever its intent.
  const surface = draftSurface(parsed.data as unknown as Record<string, unknown>);
  const dangerous = scanExecutable(surface);
  const injection = scanInjection(surface);
  const blocking = [...dangerous, ...injection].filter((f) => f.severity === 'block');
  if (blocking.length) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'submission contains content that would be read as instruction by other agents',
        flags: blocking,
        note:
          'Findings are executed. A workaround or check that fetches and runs remote ' +
          'code, reads credentials, or deletes outside a temp directory will not be ' +
          'minted regardless of intent. Describe the fix instead of scripting it.',
      },
      { status: 422 },
    );
  }

  // Warn, never silently publish: only the submitter knows what is sensitive.
  const sensitive = scanSensitive(surface);

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
    warnings: {
      sensitive,
      executable: dangerous,
      ...(sensitive.length
        ? {
            advice:
              'These would become public. Redact them before pushing. A scan cannot ' +
              'know which hostname is internal or which path names a customer — read ' +
              'it yourself.',
          }
        : {}),
    },
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
