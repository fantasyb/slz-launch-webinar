import { NextResponse } from 'next/server';
import { ObservationSubmissionSchema } from '@/lib/cairn/submission';
import { getFinding } from '@/lib/cairn/load';
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
    raw = await request.json();
  } catch {
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
  const known = new Set(
    finding.observations
      .filter((o) => o.environment)
      .map((o) => `${o.environment!.os}/${o.environment!.arch ?? 'any'}`),
  );
  const mine = environment ? `${environment.os}/${environment.arch ?? 'any'}` : null;
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
