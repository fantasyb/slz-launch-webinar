/**
 * Which findings are about THIS machine.
 *
 *   npm run cairn:match
 *
 * Ranks the corpus by whether its preconditions hold here, rather than by how
 * many strangers confirmed it. For an environment-specific finding that is the
 * only question that matters: breadth tells you a claim is true everywhere,
 * and "everywhere" is not what you are standing in.
 *
 * Nothing is executed. Predicates are read, not run.
 */
import { loadCorpus } from '../src/lib/cairn/load';
import { matchEnvironment } from '../src/lib/cairn/precondition';
import { confidence, standing } from '../src/lib/cairn/decay';

const showAll = process.argv.includes('--all');
const corpus = loadCorpus().filter((f) => f.status === 'active');

const withPre = corpus.filter((f) => f.precondition?.length);
const matched: typeof corpus = [];
const near: Array<{ f: (typeof corpus)[number]; held: number; of: number; missing: string[] }> = [];

for (const f of withPre) {
  const r = matchEnvironment(f.precondition);
  const held = r.detail.filter((d) => d.held).length;
  if (r.matches) matched.push(f);
  else near.push({ f, held, of: r.detail.length, missing: r.detail.filter((d) => !d.held).map((d) => d.predicate) });
}

console.log(`\n${matched.length} finding(s) apply to this environment\n`);
for (const f of matched) {
  console.log(`  ${f.id}  ${standing(f).padEnd(9)} ${String(Math.round(confidence(f) * 100) + '%').padEnd(5)} ${f.title.slice(0, 60)}`);
  console.log(`      ${f.precondition!.join('  ')}`);
}

if (near.length) {
  near.sort((a, b) => b.held / b.of - a.held / a.of);
  console.log(`\n${near.length} finding(s) declare preconditions that do not hold here:`);
  for (const n of near.slice(0, showAll ? near.length : 5)) {
    console.log(`  ${n.f.id}  ${n.held}/${n.of} held — missing: ${n.missing.join(', ')}`);
  }
  if (!showAll && near.length > 5) console.log(`  … ${near.length - 5} more (--all)`);
}

const none = corpus.length - withPre.length;
if (none) {
  console.log(
    `\n${none} active finding(s) declare no precondition, so nothing can say whether they` +
      `\napply here. For an environment-specific finding that is a gap, not a default.`,
  );
}
console.log('');
