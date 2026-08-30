import { NextResponse } from 'next/server';
import { loadCorpus, serialize } from '@/lib/cairn/load';
import { confidence } from '@/lib/cairn/decay';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const minConfidence = Number(searchParams.get('minConfidence') ?? 0);
  const ecosystem = searchParams.get('ecosystem');
  const subject = searchParams.get('subject');
  const includeRetired = searchParams.get('includeRetired') === 'true';

  let findings = loadCorpus();
  if (!includeRetired) findings = findings.filter((f) => f.status !== 'retired');
  if (ecosystem) findings = findings.filter((f) => f.subject.ecosystem === ecosystem);
  if (subject) findings = findings.filter((f) => f.subject.name === subject);
  findings = findings.filter((f) => confidence(f) >= minConfidence);

  return NextResponse.json({
    count: findings.length,
    generatedAt: new Date().toISOString(),
    findings: findings
      .sort((a, b) => confidence(b) - confidence(a))
      .map((f) => serialize(f)),
  });
}
