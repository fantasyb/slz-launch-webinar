import { NextResponse } from 'next/server';
import { readJsonBody, BodyTooLarge } from '@/lib/cairn/httpBody';
import { ObservationSubmissionSchema } from '@/lib/cairn/submission';
import { getFinding } from '@/lib/cairn/load';
import { environmentSignature } from '@/lib/cairn/schema';
import { environmentCount, standing, confidence } from '@/lib/cairn/decay';

export const dynamic = 'force-dynamic';

/**
 * Add an observation to an existing finding.
 *
 * This is the highest-value contribution in the system and the cheapest to
 * make: breadth of environment is what lets a claim earn universal scope, so a
 * confirmation from a machine nobody has tested is worth more than another new
 * finding.
 */
export async function POST(request: Request) {
  let raw: unknown;
  try {
    raw = await readJsonBody(request);
  } catch (e) {
    if (e instanceof BodyTooLarge) return NextResponse.json({ ok: false, error: e.message }, { status: 413 });
    return NextResponse.json({ ok: false, error: 'body must be JSON' }, { status: 400 });
  }

  const parsed = ObservationSubmissionSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        error: 'observation did not validate',
        issues: parsed.error.issues.map((i) => ({ field: i.path.join('.'), problem: i.message })),
        required: 'findingId, verdict (confirmed|refuted|inconclusive), by, note. environment strongly recommended.',
      },
      { status: 400 },
    );
  }

  const { findingId, verdict, by, note, environment } = parsed.data;
  const finding = getFinding(findingId);
  if (!finding) {
    return NextResponse.json({ ok: false, error: `no finding ${findingId}` }, { status: 404 });
  }

  const observation = { at: new Date().toISOString(), by, verdict, note, ...(environment ? { environment } : {}) };
  // environmentSignature, and the same confirmed-only filter environmentCount
  // uses. Comparing `os/arch` by hand disagreed with the scorer three ways: it
  // ignored `runtime`, so a contributor on a different Node was told their
  // observation added no breadth when it did; it did not lowercase, so
  // "Linux" and "linux" read as two environments here and one there; and it
  // counted environments from refuted observations, which buy no breadth.
  // This field exists to tell a contributor whether their run is worth
  // submitting, so it has to answer the question the scorer will answer.
  const known = new Set(
    finding.observations
      .filter((o) => o.verdict === 'confirmed' && o.environment)
      .map((o) => environmentSignature(o.environment!)),
  );
  const mine = environment ? environmentSignature(environment) : null;
  const newEnvironment = mine !== null && !known.has(mine);

  return NextResponse.json({
    ok: true,
    findingId,
    observation,
    current: {
      standing: standing(finding),
      confidence: Number(confidence(finding).toFixed(3)),
      environments: environmentCount(finding, new Date()),
      scope: finding.scope,
    },
    newEnvironment,
    next: {
      instruction:
        `Append \`observation\` to the \`observations\` array of the finding whose id is ` +
        `${findingId}, then open a pull request. Never edit an existing observation — append yours.`,
      commands: [
        `git checkout -b observe/${findingId}-${by.replace(/[^\w.-]/g, '-')}`.slice(0, 70),
        `# append the observation object to observations[] in cairn/*${findingId.slice(6)}*.json`,
        'npm run cairn:lint',
        `git commit -am "observe ${findingId}: ${verdict}" && git push -u origin HEAD`,
      ],
    },
    notes: newEnvironment
      ? [
          'This is an environment nobody has tested. It is the most valuable contribution ' +
            'available, because breadth is what lets the claim earn universal scope.',
        ]
      : [
          'This environment is already represented, so it adds corroboration but no breadth. ' +
            'Still worth submitting — recency drives confidence too.',
        ],
  });
}
