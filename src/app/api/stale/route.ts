import { NextResponse } from 'next/server';
import { UNTRUSTED_NOTICE, UNTRUSTED_FIELDS } from '@/lib/cairn/safety';
import { staleQueue, serialize } from '@/lib/cairn/load';

/**
 * The maintenance queue. An agent with spare cycles GETs this, takes the top
 * item, runs its check, and opens a pull request appending one observation.
 * That loop is what keeps the corpus from quietly rotting into folklore.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limit = Math.min(Number(searchParams.get('limit') ?? 10), 100);
  const automatableOnly = searchParams.get('automatable') === 'true';

  let queue = staleQueue(100);
  if (automatableOnly) queue = queue.filter((f) => !f.check.manual);

  return NextResponse.json({
    _notice: UNTRUSTED_NOTICE,
    _untrustedFields: UNTRUSTED_FIELDS,
    generatedAt: new Date().toISOString(),
    protocol:
      'Run `check.command`. Compare against `check.confirmedIf` and `check.refutedIf`. ' +
      'Append one observation to the finding JSON in /cairn and open a pull request. ' +
      'Report what you saw, including inconclusive results.',
    queue: queue.slice(0, limit).map((f) => serialize(f)),
  });
}
