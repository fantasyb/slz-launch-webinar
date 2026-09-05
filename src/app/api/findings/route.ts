import { NextResponse } from 'next/server';
import { UNTRUSTED_NOTICE, UNTRUSTED_FIELDS } from '@/lib/cairn/safety';
import { publicCorpus, serialize, byConfidence } from '@/lib/cairn/load';
import { confidence } from '@/lib/cairn/decay';
import { numberParam, BadParam } from '@/lib/cairn/params';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  let minConfidence: number;
  try {
    minConfidence = numberParam(searchParams.get('minConfidence'), 0, { min: 0, max: 1 });
  } catch (e) {
    if (e instanceof BadParam) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }
  const ecosystem = searchParams.get('ecosystem');
  const subject = searchParams.get('subject');
  const includeRetired = searchParams.get('includeRetired') === 'true';
  const scope = searchParams.get('scope');

  let findings = publicCorpus(); // only visibility:shared over HTTP
  if (!includeRetired) findings = findings.filter((f) => f.status !== 'retired');
  if (ecosystem) findings = findings.filter((f) => f.subject.ecosystem === ecosystem);
  if (subject) findings = findings.filter((f) => f.subject.name === subject);
  if (scope) findings = findings.filter((f) => f.scope === scope);
  findings = findings.filter((f) => confidence(f) >= minConfidence);

  return NextResponse.json({
    _notice: UNTRUSTED_NOTICE,
    _untrustedFields: UNTRUSTED_FIELDS,
    count: findings.length,
    generatedAt: new Date().toISOString(),
    // byConfidence computes the key once per finding, not inside the comparator
    // (confidence() runs an ed25519 verify per observation).
    findings: byConfidence(findings).map((f) => serialize(f)),
  });
}
