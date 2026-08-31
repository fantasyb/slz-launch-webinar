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
