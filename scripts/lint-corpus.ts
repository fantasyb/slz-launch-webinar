/**
 * Validates every finding against the schema and applies the editorial rules
 * the schema cannot express. Run before opening a pull request.
 */
import fs from 'fs';
import path from 'path';
import { FindingSchema, environmentSignature } from '../src/lib/cairn/schema';
import { canonicalSubject, subjectCollisions } from '../src/lib/cairn/subject';
import { commitmentStatus } from '../src/lib/cairn/commitment';
import { verifyObservation, findingBodyHash } from '../src/lib/cairn/signing';
import { derivedVerdict } from '../src/lib/cairn/decay';
import { loadKeys } from '../src/lib/cairn/keys';
import { scanExecutable, scanInjection } from '../src/lib/cairn/safety';
import { longestVerbatimRun, VERBATIM_RUN_LIMIT, indexedText } from '../src/lib/cairn/evalset';
import { homePath } from '../src/lib/cairn/home';
import { readsAsProse } from '../src/lib/cairn/submission';
import { checkFlaws } from '../src/lib/cairn/checkquality';

const DIR = homePath('cairn');
const problems: string[] = [];
const warnings: string[] = [];

const keys = loadKeys();
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();
const ids = new Set<string>();
/** Every finding that parsed, for the corpus-wide checks after the loop. */
const all: Array<ReturnType<typeof FindingSchema.parse>> = [];

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
  all.push(f);
  // Scaffold placeholders are an error, not a warning.
  //
  // `cairn:new` writes a template whose every prose field reads "TODO — ...".
  // Nothing checked for them, so a finding with an unfilled claim and a
  // check command reading "TODO — cheap, hermetic, side-effect free." passed
  // with 0 errors. An agent that runs cairn:new, gets distracted and opens a
  // pull request would have had it accepted by CI. Caught this by watching an
  // agent do exactly that, mid-write.
  const scaffold: string[] = [];
  const seek = (v: unknown, at: string): void => {
    if (typeof v === 'string') {
      if (v.includes('TODO')) scaffold.push(at);
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => seek(x, `${at}[${i}]`));
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) seek(x, at ? `${at}.${k}` : k);
    }
  };
  seek(data, '');
  if (scaffold.length > 0) {
    problems.push(
      `${file}: ${scaffold.length} field(s) still hold cairn:new scaffold text ` +
        `(${scaffold.slice(0, 3).join(', ')}${scaffold.length > 3 ? ', …' : ''}) — ` +
        `fill them in or delete the draft`,
    );
  }

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

  /*
   * Triggers: a warning that fires wrongly is worse than one that never fires.
   *
   * `triggers` drives the only retrieval path that interrupts an agent before
   * it acts, so a bad entry does not merely fail to help -- it teaches its
   * reader to dismiss the channel. Both rules below were derived from a real
   * generated batch, where a model attached `ssh-keygen` to a finding about
   * security-test design (an invention) and `npm install` to one about
   * Playwright (real, and useless, because everybody runs it all day).
   */
  const WRAPPER_VERBS = new Set([
    'npm', 'git', 'yarn', 'pnpm', 'bun', 'cargo', 'go', 'pip', 'pip3',
    'docker', 'make', 'brew', 'apt', 'apt-get',
  ]);
  /*
   * Commands so common that warning on them warns on everything.
   *
   * Found by reading the generated triggers rather than by testing, which is
   * the point of reading them: `curl` was attached to four findings and only
   * one was about curl. An ordinary `curl -sS https://example.com/` raised
   * three warnings -- an RCE pattern, a server-side signing-oracle design, and
   * a DNS egress note -- none of which have anything to tell you before you
   * fetch a URL. The quietness suite missed it because it contained no bare
   * curl, which is exactly how a cry-wolf channel gets shipped.
   *
   * These may only be triggers when the finding is ABOUT the command itself.
   * `df` on a finding whose subject is df, yes; `curl` on a finding about the
   * HTTP Host header, no.
   */
  const UBIQUITOUS = new Set([
    'curl', 'wget', 'ssh', 'node', 'python', 'python3', 'java', 'ruby',
    'perl', 'tar', 'rsync', 'scp', 'kubectl', 'terraform',
  ]);
  for (const t of f.triggers ?? []) {
    const words = t.trim().toLowerCase().split(/\s+/);
    // 1. ATTESTED: the finding may only warn about a command it discusses.
    const body = [
      f.title, f.claim, f.expectation, f.reality, f.workaround ?? '',
      f.mechanism ?? '', f.appliesTo ?? '', f.subject.name,
      f.check.command, f.tags.join(' '),
      ...(f.evidence ?? []).flatMap((e) => [e.command ?? '', e.output ?? '']),
    ].join('\n').toLowerCase();
    if (!words.every((w) => body.includes(w))) {
      problems.push(`${file}: trigger "${t}" appears nowhere in the finding — invented?`);
    }
    // 2. SPECIFIC: a wrapper verb identifies a trap only when its argument
    //    names the subject. `playwright install` yes; `npm install` no.
    if (UBIQUITOUS.has(words[0]) && words.length === 1) {
      const subject = canonicalSubject(f.subject.name);
      if (!subject.split(/[^a-z0-9.:_-]+/).includes(words[0])) {
        problems.push(
          `${file}: trigger "${t}" is a ubiquitous command and this finding's subject ` +
          `is "${f.subject.name}" — it would warn on ordinary use`,
        );
      }
    }
    if (WRAPPER_VERBS.has(words[0])) {
      const subject = canonicalSubject(f.subject.name);
      const names = words.slice(1).some((w) => subject.includes(w) || w.includes(subject));
      if (!names) {
        problems.push(
          `${file}: trigger "${t}" is a ${words[0]} verb that does not name the subject ` +
          `"${f.subject.name}" — it would fire on ordinary use`,
        );
      }
    }
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
  // The same predicate the submission path uses to derive `manual`, imported
  // rather than restated: two copies of this rule drifting is how the record
  // path came to write findings this linter refuses.
  /*
   * A warning, not an error, and deliberately asymmetric with the write path.
   * `record` refuses these outright; the existing corpus is graded rather
   * than blocked, because retroactively erroring on fifteen checks written
   * before the rule existed stops every commit and teaches nobody anything.
   * The count is the number worth watching.
   */
  for (const flaw of checkFlaws(f.check)) {
    warnings.push(`${file}: check ${flaw.rule} — ${flaw.detail}`);
  }

  if (!f.check.manual && readsAsProse(f.check.command)) {
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
    // A recorded outcome with no `resolvedAt` used to skip this check entirely.
    // `resolvedAt` is optional in the schema and only reveal.ts writes it, so a
    // hand-edited reveal that copied the real preimage (keeping the hash valid)
    // and simply omitted the field could record `confirmed` on a refuted
    // finding: lint passed, audit certified it "provably sealed before
    // resolution", and a fabricated Brier of 0.0025 reached the training
    // export. The seal binds the prior; it never bound the answer key.
    if (pred.outcome && !pred.resolvedAt) {
      problems.push(
        `${file}: prediction by ${pred.by} records an outcome with no resolvedAt, so it ` +
          `cannot be checked against the observations. Reveal with cairn:reveal.`,
      );
    }
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
          `${file}: prediction by ${pred.by} carries no bodyHash, so nothing binds it ` +
            `to the claim it forecast; it is not scored`,
        );
      } else {
        const expected = derivedVerdict(f, {
          since: new Date(pred.at),
          asOf: new Date(pred.resolvedAt),
        });
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

/*
 * Subject drift, checked corpus-wide rather than per finding.
 *
 * `subject.name` is free text doing identity work: the sibling link, the
 * duplicate candidate generator and admission control all compare subjects to
 * decide whether two findings are about the same thing. Comparing
 * unnormalized attributes fails in the direction hardest to notice -- not
 * wrong answers, but MISSED matches, which read as "no duplicates found".
 *
 * A warning rather than an error, because neither case is necessarily a
 * mistake. Two spellings of one subject is drift worth fixing; one subject in
 * two ecosystems is a genuine ambiguity only a person can settle -- either the
 * findings are about one entity and the ecosystems disagree, or they are two
 * entities that need distinguishable names.
 */
for (const c of subjectCollisions(all)) {
  warnings.push(
    `subject "${c.canonical}": ${c.detail} — ${c.ids.join(', ')}. ` +
    (c.kind === 'spelling'
      ? 'Pick one spelling; identity rules compare these.'
      : 'One entity with disagreeing ecosystems, or two that need distinct names.'),
  );
}

/*
 * NO FINDING MAY CONTAIN AN EVALUATION QUERY VERBATIM.
 *
 * The field queries in data/field-queries.json are what an agent actually
 * typed, harvested afterwards, and they are the only honest measurement this
 * project has. A finding that reproduces one wins it on perfect coverage and
 * becomes the answer to a question it is not about.
 *
 * That is not hypothetical. The record describing this very failure quoted the
 * queries in its evidence and immediately started intercepting them — a
 * measurement quietly replaced by a record about the measurement. Findings must
 * describe eval queries, never reproduce them.
 *
 * The same invariant already protects the generated expansions, for the same
 * reason and with the same run length.
 */
try {
  const field = JSON.parse(fs.readFileSync(homePath('data', 'field-queries.json'), 'utf8')) as {
    queries: { q: string }[];
  };
  for (const f of all) {
    const doc = indexedText(f);
    for (const { q } of field.queries) {
      if (longestVerbatimRun(q, doc) >= VERBATIM_RUN_LIMIT) {
        problems.push(
          `${f.id}: contains an evaluation query verbatim — "${q.slice(0, 56)}…". ` +
            'Describe it instead; a finding that reproduces a query wins it on coverage.',
        );
      }
    }
  }

  /*
   * The generated expansions are indexed too, and a model asked to write the
   * queries a searcher would arrive with is exactly the thing most likely to
   * land on one of them by coincidence. Same rule, same run length.
   */
  const gen = JSON.parse(fs.readFileSync(homePath('data', 'expansions.json'), 'utf8')) as {
    expansions: Record<string, string[]>;
  };
  for (const [id, queries] of Object.entries(gen.expansions ?? {})) {
    for (const g of queries) {
      for (const { q } of field.queries) {
        if (longestVerbatimRun(q, g) >= VERBATIM_RUN_LIMIT) {
          problems.push(
            `${id}: a generated expansion reproduces an evaluation query — "${g.slice(0, 56)}…". ` +
              'Delete that line from data/expansions.json; it makes the field suite score itself.',
          );
        }
      }
    }
  }
} catch {
  /* No field queries yet: nothing to protect. */
}

for (const w of warnings) console.warn(`warn  ${w}`);
for (const p of problems) console.error(`error ${p}`);

console.log(
  `\n${files.length} findings · ${problems.length} errors · ${warnings.length} warnings`,
);
// 0 clean, 1 errors, 2 warnings only. Collapsing warnings into success meant
// CI could not gate on them -- and at least one warning, a filename that
// disagrees with the id inside it, is a precursor to a duplicate id that takes
// the whole corpus down.
if (problems.length > 0) process.exit(1);
process.exit(warnings.length > 0 ? 2 : 0);
