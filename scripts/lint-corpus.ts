/**
 * Validates every finding against the schema and applies the editorial rules
 * the schema cannot express. Run before opening a pull request.
 */
import fs from 'fs';
import path from 'path';
import { FindingSchema, environmentSignature } from '../src/lib/cairn/schema';
import { commitmentStatus } from '../src/lib/cairn/commitment';

const DIR = path.join(process.cwd(), 'cairn');
const problems: string[] = [];
const warnings: string[] = [];

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();
const ids = new Set<string>();

for (const file of files) {
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
  } catch (e) {
    problems.push(`${file}: invalid JSON — ${(e as Error).message}`);
    continue;
  }

  const parsed = FindingSchema.safeParse(data);
  if (!parsed.success) {
    for (const i of parsed.error.issues) {
      problems.push(`${file}: ${i.path.join('.')} — ${i.message}`);
    }
    continue;
  }

  const f = parsed.data;
  if (ids.has(f.id)) problems.push(`${file}: duplicate id ${f.id}`);
  ids.add(f.id);

  if (!file.startsWith(f.id.replace('cairn-', ''))) {
    warnings.push(`${file}: filename should begin with ${f.id.replace('cairn-', '')}`);
  }
  if (f.status === 'retired' && !f.retiredReason) {
    problems.push(`${file}: retired findings must carry a retiredReason`);
  }
  if (f.provenance === 'firsthand' && f.evidence.length === 0) {
    problems.push(`${file}: firsthand findings must include at least one piece of evidence`);
  }
  if (f.claim.length < 40) {
    warnings.push(`${file}: claim is very short — is it falsifiable as written?`);
  }
  if (f.scope === 'environment-specific' && !f.appliesTo) {
    problems.push(`${file}: environment-specific findings must state appliesTo`);
  }
  if (f.scope === 'universal') {
    const envs = new Set(
      f.observations
        .filter((o) => o.verdict === 'confirmed' && o.environment)
        .map((o) => environmentSignature(o.environment!)),
    );
    if (envs.size < 2 && f.status === 'active') {
      warnings.push(
        `${file}: claims universal scope on ${envs.size} environment(s) — ` +
          `scored down until confirmed elsewhere. Consider environment-specific.`,
      );
    }
  }
  for (const pred of f.predictions) {
    const status = commitmentStatus(f.id, pred);
    if (status === 'broken') {
      problems.push(
        `${file}: prediction by ${pred.by} does not recompute its published seal — ` +
          `tampered or malformed, and will never be scored`,
      );
    }
    if (status === 'unanchored' && !pred.self) {
      problems.push(
        `${file}: prediction by ${pred.by} has no commitment. Seal it with ` +
          `cairn:predict, or mark self:true to record it unscored.`,
      );
    }
    if (pred.outcome && pred.priorConfirmed === undefined && pred.commitment) {
      problems.push(`${file}: prediction by ${pred.by} resolved while still sealed — reveal it`);
    }
  }
  if (f.check.confirmedIf === f.check.refutedIf) {
    problems.push(`${file}: confirmedIf and refutedIf are identical — the check decides nothing`);
  }
  for (const o of f.observations) {
    if (new Date(o.at).getTime() > Date.now() + 86_400_000) {
      problems.push(`${file}: observation dated in the future (${o.at})`);
    }
  }
}

for (const w of warnings) console.warn(`warn  ${w}`);
for (const p of problems) console.error(`error ${p}`);

console.log(
  `\n${files.length} findings · ${problems.length} errors · ${warnings.length} warnings`,
);
process.exit(problems.length > 0 ? 1 : 0);
