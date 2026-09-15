/**
 * Canonical subject identity: standardize before you match.
 *
 * `subject.name` is free text doing identity work. Every rule built on top of
 * it -- the sibling link, the candidate generator in cairn:resolve, the
 * ubiquitous-command trigger check, admission control -- compares subjects to
 * decide whether two findings are about the same thing. Comparing
 * unnormalized attributes is what canonicalization exists to prevent, and it
 * fails in the direction that is hardest to notice: not wrong answers, but
 * MISSED matches, which read as "no duplicates found".
 *
 * That is the same shape as three other bugs found in this project on the same
 * day -- a guard reading the wrong TOTAL, a lint rule nested inside an `if`
 * that was never true, confusion learning whose probe could no longer vary.
 * Each passed while checking nothing.
 *
 * WHAT THE REAL CORPUS ALREADY SHOWS
 *
 *   commit-reveal forecasting  (design)    cairn-0018
 *   commit-reveal forecasting  (protocol)  cairn-0023
 *
 * One subject, two ecosystems. Any rule keyed on name-plus-ecosystem treats
 * those as different entities; any rule keyed on name alone treats findings in
 * genuinely different ecosystems as the same. Both are wrong and the
 * disagreement is invisible until something depends on it.
 *
 * Five subjects are capitalized where twenty-six are not (`CI review gates`,
 * `HTTP Host header`, `LLM completion APIs`, `Pearson correlation`, `Web
 * Storage API`). Existing comparisons lowercase, so that costs nothing today
 * -- which is exactly why it drifts.
 *
 * WHAT THIS DOES NOT DO
 *
 * It does not merge `commitment schemes` into `commit-reveal forecasting`.
 * Those may well be one entity, but deciding so is a corpus edit with
 * consequences for signatures and scope, and a normalizer that quietly
 * rewrites what a finding says it is about would be a worse bug than the drift
 * it prevents. Aliases are declared, never inferred.
 */

/** Declared equivalences. Nothing is inferred; a person adds a line here. */
const ALIASES: Record<string, string> = {
  'next.js': 'next',
  nextjs: 'next',
  'node.js': 'node',
  nodejs: 'node',
  'rip grep': 'ripgrep',
  rg: 'ripgrep',
  'bind utils': 'bind-utils',
};

/**
 * The comparable form of a subject name.
 *
 * Lowercase, collapse whitespace, strip trailing punctuation, then apply any
 * declared alias. Deliberately conservative: it removes formatting differences
 * and nothing else, so two subjects that canonicalize equal really are written
 * the same way.
 */
export function canonicalSubject(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[\s_]+/g, ' ')
    .replace(/[.,;:]+$/g, '')
    .trim();
  return ALIASES[base] ?? base;
}

/** True when two findings claim the same subject, formatting aside. */
export function sameSubject(a: string, b: string): boolean {
  return canonicalSubject(a) === canonicalSubject(b);
}

/**
 * Subjects that canonicalize to the same string but are written differently,
 * or that are written identically while claiming different ecosystems.
 *
 * The first is drift a linter should stop. The second is an ambiguity a person
 * has to resolve -- either they are one entity and the ecosystems disagree, or
 * they are two entities that need distinguishable names.
 */
export function subjectCollisions(
  findings: Array<{ id: string; subject: { name: string; ecosystem: string } }>,
): Array<{ canonical: string; kind: 'spelling' | 'ecosystem'; ids: string[]; detail: string }> {
  const byCanonical = new Map<string, typeof findings>();
  for (const f of findings) {
    const c = canonicalSubject(f.subject.name);
    byCanonical.set(c, [...(byCanonical.get(c) ?? []), f]);
  }
  const out: ReturnType<typeof subjectCollisions> = [];
  for (const [canonical, group] of byCanonical) {
    if (group.length < 2) continue;
    const spellings = new Set(group.map((f) => f.subject.name));
    const ecosystems = new Set(group.map((f) => f.subject.ecosystem));
    if (spellings.size > 1) {
      out.push({
        canonical, kind: 'spelling', ids: group.map((f) => f.id),
        detail: `written as ${[...spellings].map((s) => `"${s}"`).join(' and ')}`,
      });
    }
    if (ecosystems.size > 1) {
      out.push({
        canonical, kind: 'ecosystem', ids: group.map((f) => f.id),
        detail: `same subject in ecosystems ${[...ecosystems].map((e) => `"${e}"`).join(' and ')}`,
      });
    }
  }
  return out;
}
