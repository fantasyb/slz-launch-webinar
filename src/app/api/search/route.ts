import { NextResponse } from 'next/server';
import { UNTRUSTED_NOTICE, UNTRUSTED_FIELDS } from '@/lib/cairn/safety';
import { serialize, summarise } from '@/lib/cairn/load';
import { loadSearchable } from '@/lib/cairn/federation';
import { retrieve } from '@/lib/cairn/retrieval';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get('q') ?? '';
  if (!q.trim()) {
    return NextResponse.json({ error: 'missing required parameter: q' }, { status: 400 });
  }
  // Retired findings are excluded by default, matching /api/findings. A
  // finding is retired because it stopped being true; search returning it
  // beside live ones, with nothing to distinguish them at the summary
  // projection, is how a withdrawn claim gets acted on.
  const includeRetired = searchParams.get('includeRetired') === 'true';
  /*
   * Preconditions are NOT evaluated here, and that is deliberate.
   *
   * This server is not the machine asking. Gating a remote query on whether
   * THIS process has HTTPS_PROXY set would hide exactly the findings the asker
   * needs and surface ones about a container they are not in. `cairn:find`
   * runs on the asker's own machine and does use them.
   */
  /*
   * This corpus AND its upstreams, matching the CLI. A server that answered
   * only from its own directory while `cairn:find` on the same install
   * answered from both would be two different corpora behind one name.
   */
  const hits = retrieve(q, loadSearchable().findings);
  const kept = includeRetired ? hits : hits.filter((h) => h.finding.status !== 'retired');
  const results = kept.map((h) => h.finding);
  // Default to the minimal projection. Full prose is a deliberate second
  // request for one finding, not a side effect of asking a broad question.
  const full = searchParams.get('full') === 'true';
  return NextResponse.json({
    _notice: UNTRUSTED_NOTICE,
    _untrustedFields: UNTRUSTED_FIELDS,
    query: q,
    count: results.length,
    generatedAt: new Date().toISOString(),
    findings: kept.map((h) =>
      full
        ? serialize(h.finding)
        : {
            ...summarise(h.finding),
            // Why this was returned, so an agent can judge the match rather
            // than trust the order — and which other findings in this result
            // are about the same trap, so it does not read a coin flip as a
            // preference.
            matched: h.matched.slice(0, 6).map((m) => m.term),
            siblings: h.siblings,
            // Honest self-report. This code cannot tell a lexical accident
            // from a real match -- six different statistics were measured and
            // none separates them -- but the caller has semantics, and what it
            // cannot recover on its own is HOW the match was made.
            strength: h.strength,
            caveats: h.caveats,
            explained: Number(h.explained.toFixed(2)),
          },
    ),
    projection: full ? 'full' : 'summary',
    hint: full
      ? undefined
      : 'Titles and standings only. Fetch `detail` for the one finding you care ' +
        'about rather than absorbing every match — less untrusted prose enters ' +
        'your context, and only for a finding you chose.',
  });
}
