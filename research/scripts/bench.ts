/**
 * cairn:bench — end to end, honestly.
 *
 *   npm run cairn:bench
 *   CAIRN_BENCH_URL=http://localhost:3000 npm run cairn:bench   # include the HTTP path
 *
 * The retrieval number quoted so far — 0.028ms a query — is true and close to
 * meaningless on its own, because no agent ever experiences it. An agent
 * experiences a cold process: node starts, the corpus is parsed and validated,
 * every signature is verified to compute confidence, the index is built, and
 * only then is a query answered. That whole path is the product. This measures
 * it, and separates the parts, so a fast inner loop cannot hide a slow one.
 *
 * Everything here is measured on the real corpus. Nothing is extrapolated.
 */
import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { promisify } from 'util';
import { loadCorpus } from '../../src/lib/cairn/load';
import { retrieve, buildIndex, associationStatus } from '../../src/lib/cairn/retrieval';
import { runCommand } from '../../src/lib/cairn/confirm';

const exec = promisify(execFile);

/** Realistic queries: what an agent has in hand, not what a person would type. */
const QUERIES = [
  'ENOSPC: no space left on device, write',
  'Error: browserType.launch: Executable doesn\'t exist at /root/.cache/ms-playwright',
  'curl: (56) CONNECT tunnel failed, response 403',
  'rg: regex parse error: repetition quantifier expects a valid decimal',
  'getaddrinfo ENOTFOUND registry.example.com',
];

function stats(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  const pct = (p: number) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return {
    mean: s.reduce((a, b) => a + b, 0) / s.length,
    p50: pct(0.5),
    p95: pct(0.95),
    max: s[s.length - 1],
  };
}

const ms = (n: number) => (n < 1 ? n.toFixed(3) : n.toFixed(1)).padStart(8) + ' ms';

async function main() {
  console.log('\nCAIRN BENCHMARK — real corpus, no extrapolation\n' + '='.repeat(58));

  // ---- 1. cold start: what an agent actually pays -------------------------
  // Spawned as a real process, because the cost being measured is node boot,
  // module load, corpus parse and signature verification -- none of which an
  // in-process timer can see, and all of which the agent waits for.
  // Measures what actually ships. Pointing this at `tsx` measured the
  // transpiler, which is how 614ms of TypeScript compilation hid inside a
  // number reported as retrieval latency for two rounds.
  const bundled = existsSync('dist/cli/find.js');
  const cold: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t = process.hrtime.bigint();
    if (bundled) {
      await exec(process.execPath, ['dist/cli/find.js', QUERIES[i % QUERIES.length]], {
        cwd: process.cwd(), maxBuffer: 1 << 22,
      });
    } else {
      await exec('npx', ['tsx', 'scripts/find.ts', QUERIES[i % QUERIES.length]], {
        cwd: process.cwd(), maxBuffer: 1 << 22,
      });
    }
    cold.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  const c = stats(cold);
  console.log(`\nCOLD START — spawn to ranked answer${bundled ? '' : '  (tsx fallback: run cairn:build-cli)'}`);
  console.log(`  mean ${ms(c.mean)}   p50 ${ms(c.p50)}   max ${ms(c.max)}`);
  console.log('  This is the number an agent feels. Everything below is inside it.');

  // ---- 2. the parts ------------------------------------------------------
  const t0 = process.hrtime.bigint();
  const all = loadCorpus();
  const loadMs = Number(process.hrtime.bigint() - t0) / 1e6;

  const t1 = process.hrtime.bigint();
  buildIndex(all);
  const indexMs = Number(process.hrtime.bigint() - t1) / 1e6;

  console.log('\nBREAKDOWN (in-process, corpus of ' + all.length + ')');
  console.log(`  parse + validate corpus      ${ms(loadMs)}`);
  console.log(`  build index (once/process)   ${ms(indexMs)}`);
  console.log('    includes an ed25519 verification per signed observation, to');
  console.log('    cache confidence. It is the trust model\'s cost, not search\'s.');

  // ---- 3. warm query -----------------------------------------------------
  for (const q of QUERIES) retrieve(q, all); // warm
  const warm: number[] = [];
  for (let i = 0; i < 5000; i++) {
    const t = process.hrtime.bigint();
    retrieve(QUERIES[i % QUERIES.length], all);
    warm.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  const w = stats(warm);
  console.log('\nWARM QUERY (index already built, 5000 samples)');
  console.log(`  mean ${ms(w.mean)}   p50 ${ms(w.p50)}   p95 ${ms(w.p95)}   max ${ms(w.max)}`);

  // ---- 4. scale ----------------------------------------------------------
  // Distinct text per finding, so postings lists are realistic rather than
  // thousands of copies of the same document.
  console.log('\nSCALE (synthetic, distinct text per finding)');
  for (const size of [1_000, 10_000]) {
    const big = Array.from({ length: size }, (_, i) => ({
      ...all[i % all.length],
      id: 'x' + i,
      title: 'finding ' + i + ' about widget' + i,
      tags: ['t' + i],
      claim: 'widget' + i + ' fails with WIDGETERR' + i,
    }));
    const b = process.hrtime.bigint();
    buildIndex(big as typeof all);
    const bMs = Number(process.hrtime.bigint() - b) / 1e6;
    const samples: number[] = [];
    for (let i = 0; i < 500; i++) {
      const t = process.hrtime.bigint();
      retrieve('WIDGETERR' + (i * 7) % size, big as typeof all);
      samples.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    const s = stats(samples);
    console.log(
      `  ${String(size).padStart(6)} findings   query mean ${ms(s.mean)}  p95 ${ms(s.p95)}` +
        `   (index build ${(bMs / 1000).toFixed(1)}s once)`,
    );
  }

  // ---- 5. execution ------------------------------------------------------
  const runnable = all.filter((f) => f.status === 'active' && !f.check.manual);
  const e0 = process.hrtime.bigint();
  await Promise.all(
    runnable.slice(0, 8).map((f) => runCommand(f.id, f.check.command, 30_000)),
  );
  const par = Number(process.hrtime.bigint() - e0) / 1e6;
  const e1 = process.hrtime.bigint();
  for (const f of runnable.slice(0, 8)) await runCommand(f.id, f.check.command, 30_000);
  const ser = Number(process.hrtime.bigint() - e1) / 1e6;
  console.log('\nCHECK EXECUTION (8 real checks)');
  console.log(`  parallel ${ms(par)}   serial ${ms(ser)}   speedup ${(ser / par).toFixed(1)}x`);

  // ---- 6. HTTP ------------------------------------------------------------
  const url = process.env.CAIRN_BENCH_URL;
  if (url) {
    const http: number[] = [];
    for (let i = 0; i < 30; i++) {
      const t = process.hrtime.bigint();
      const r = await fetch(`${url}/api/search?q=${encodeURIComponent(QUERIES[i % QUERIES.length])}`);
      await r.json();
      http.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    const h = stats(http);
    console.log('\nHTTP /api/search (30 requests)');
    console.log(`  mean ${ms(h.mean)}   p50 ${ms(h.p50)}   p95 ${ms(h.p95)}`);
  } else {
    console.log('\nHTTP /api/search — skipped (set CAIRN_BENCH_URL to include it)');
  }

  // ---- 7. what the numbers are worth --------------------------------------
  const st = associationStatus(all);
  console.log('\n' + '='.repeat(58));
  console.log('CAVEATS, so the numbers are not read as more than they are:');
  console.log(`  · corpus is ${all.length} findings from 1 contributor. Scale figures are`);
  console.log('    synthetic and measure the algorithm, not real-world distribution.');
  console.log(`  · association: ${st.reason}`);
  console.log('  · accuracy is measured separately and on held-out data: cairn:eval');
  console.log();
}

void main();
