/**
 * Validates every finding against the schema and applies the editorial rules
 * the schema cannot express. Run before opening a pull request.
 */
import fs from 'fs';
import path from 'path';
import { FindingSchema, environmentSignature } from '../src/lib/cairn/schema';
import { commitmentStatus } from '../src/lib/cairn/commitment';
import { verifyObservation, findingBodyHash } from '../src/lib/cairn/signing';
import { derivedVerdict } from '../src/lib/cairn/decay';
import { loadKeys } from '../src/lib/cairn/keys';
import { scanExecutable, scanInjection } from '../src/lib/cairn/safety';

const DIR = path.join(process.cwd(), 'cairn');
const problems: string[] = [];
const warnings: string[] = [];

const keys = loadKeys();
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
  if (f.basis === 'structural') {
    if (!f.derivation) {
      problems.push(
        `${file}: structural findings must carry a derivation — the argument for why ` +
          `the property must hold. Without one it is an assertion wearing a label.`,
      );
    }
    if (f.scope !== 'universal') {
      problems.push(
        `${file}: a structural claim follows from the design, so its scope is universal ` +
          `wherever that design holds. Mark it empirical if it is really about one setup.`,
      );
    }
  }

  // A check that is prose but flagged automatable will be executed as a shell
  // command by cairn:verify. That is how cairn-0014 shipped broken.
  const cmd = f.check.command.trim().replace(/^#[^\n]*\n/, '');
  // Shells do not start sentences. A leading capital is prose unless it is an
  // ALL_CAPS environment assignment.
  const readsAsProse = /^[A-Z]/.test(cmd) && !/^[A-Z][A-Z0-9_]*=/.test(cmd);
  if (!f.check.manual && readsAsProse) {
    problems.push(
      `${file}: check.command reads as prose but manual is false — cairn:verify would ` +
        `try to execute it. Make it a command, or set manual: true.`,
    );
  }

  if (f.scope === 'environment-specific' && !f.appliesTo) {
    problems.push(`${file}: environment-specific findings must state appliesTo`);
  }
  if (f.scope === 'universal' && f.basis === 'empirical') {
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
  // Prose fields are read by agents while they decide what to do, which is the
  // position an injection wants. Blocking, not warning.
  for (const [field, text] of [
    ['title', f.title], ['claim', f.claim], ['expectation', f.expectation],
    ['reality', f.reality], ['mechanism', f.mechanism ?? ''],
    ['workaround', f.workaround ?? ''], ['derivation', f.derivation ?? ''],
    ['appliesTo', f.appliesTo ?? ''],
    ...f.evidence.map((e, i) => [`evidence[${i}]`, `${e.output}\n${e.note ?? ''}`] as const),
    ...f.observations.map((o, i) => [`observations[${i}].note`, o.note ?? ''] as const),
  ] as Array<[string, string]>) {
    for (const flag of scanInjection(text)) {
      problems.push(
        `${file}: ${field} contains ${flag.pattern} (${flag.reason}) — ${flag.sample}`,
      );
    }
  }

  // Findings are executed by agents, so the corpus is a supply chain.
  for (const [field, text] of [
    ['check.command', f.check.command],
    ['workaround', f.workaround ?? ''],
    ...f.evidence.map((e, i) => [`evidence[${i}].command`, e.command] as const),
  ] as Array<[string, string]>) {
    for (const flag of scanExecutable(text)) {
      const msg =
        `${file}: ${field} contains ${flag.pattern} (${flag.reason}) — ${flag.sample}`;
      if (flag.severity === 'block') problems.push(msg);
      else warnings.push(msg);
    }
  }

  for (const o of f.observations) {
    const sig = verifyObservation(f.id, o, keys, findingBodyHash(f));
    if (sig === 'broken') {
      problems.push(
        `${file}: observation by ${o.by} has a signature that does not verify — ` +
          `tampered, replayed from another finding, or signed by an unpublished key`,
      );
    }
    if (sig === 'mislabelled') {
      problems.push(
        `${file}: observation by ${o.by} is signed by a key published under a ` +
          `different label — impersonation`,
      );
    }
    if (sig === 'unsigned') {
      warnings.push(
        `${file}: observation by ${o.by} is unsigned — attributable to nobody, ` +
          `counts half toward breadth`,
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
    // The outcome is the ground truth a forecast is scored against, so it may
    // not be whatever the forecaster wrote. Check it against what the finding's
    // own observations supported at the moment it was resolved.
    if (pred.outcome && pred.resolvedAt) {
      const currentBody = findingBodyHash(f);
      if (pred.bodyHash && pred.bodyHash !== currentBody) {
        // Not a wrong outcome — a forecast about text that no longer exists.
        warnings.push(
          `${file}: prediction by ${pred.by} forecast a claim that has since been ` +
            `amended; its outcome is no longer checkable and it is not scored`,
        );
      } else if (!pred.bodyHash) {
        warnings.push(
          `${file}: prediction by ${pred.by} predates body binding, so its outcome ` +
            `cannot be checked against the current claim`,
        );
      } else {
        const expected = derivedVerdict(f, new Date(pred.resolvedAt));
        if (expected !== pred.outcome) {
          problems.push(
            `${file}: prediction by ${pred.by} records outcome "${pred.outcome}" but the ` +
              `finding's observations supported "${expected}" at ${pred.resolvedAt}`,
          );
        }
      }
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
