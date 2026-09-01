/**
 * Precompile the CLI entrypoints to plain JavaScript.
 *
 * Cold start was 681ms and 614ms of it was `tsx` starting a TypeScript
 * transpiler. Node itself boots in 30ms; parsing the corpus and building the
 * index is 60ms. So seven eighths of what an agent waited for was compilation
 * of code that had not changed since the last time it was compiled.
 *
 * The lookup path is the one thing here that runs in someone else's debugging
 * loop, at the exact moment they are already stuck. Every millisecond is paid
 * by someone who is having a bad time. Shipping it as JavaScript is the entire
 * fix, and it needs no change to the source.
 *
 * Bundled rather than emitted file-by-file so the runtime resolves nothing: a
 * single file, no module graph to walk, no node_modules traversal. esbuild is
 * already present as tsx's own dependency, so this adds nothing to install.
 *
 * `npm run cairn:find` uses the bundle when it is present and falls back to
 * tsx when it is not, so a fresh clone works before anyone has built anything
 * — slowly, but correctly. Correct-and-slow beats a confusing failure in a
 * tool whose whole purpose is to be consulted during confusing failures.
 */
import { build } from 'esbuild';
import { mkdirSync } from 'fs';

const ENTRIES = [
  ['scripts/find.ts', 'dist/cli/find.js'],
  ['scripts/doctor.ts', 'dist/cli/doctor.js'],
  // The brief is the delivery path with the largest measured effect — a weaker
  // model went from 0/5 to 4/5 when findings were handed over instead of
  // offered — and it was reachable only through npm, which resolves nothing
  // from another project's directory.
  ['scripts/brief.ts', 'dist/cli/brief.js'],
  // An agent has to be able to refresh its own corpus without npm and without
  // knowing where it lives.
  ['scripts/sync.ts', 'dist/cli/sync.js'],
  // Reading was portable and writing was not: recording a finding still meant
  // cd'ing into the checkout and running an npm script, so a second user could
  // consult the corpus and never add to it.
  ['scripts/record.ts', 'dist/cli/record.js'],
];

mkdirSync('dist/cli', { recursive: true });

for (const [entry, outfile] of ENTRIES) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    // The corpus is read from disk at runtime, never inlined: a stale bundle
    // must never be able to answer with stale findings.
    external: [],
    logLevel: 'warning',
  });
  console.log(`built ${outfile}`);
}
