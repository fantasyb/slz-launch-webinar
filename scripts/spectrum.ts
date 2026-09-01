/**
 * cairn:spectrum — can this corpus support embeddings at all?
 *
 *   npm run cairn:spectrum
 *
 * "Add embeddings" is the standard answer to every retrieval problem this
 * project could not rank away, and it is usually given without checking
 * whether the corpus has the structure embeddings exploit. This checks, in
 * about a second, with no dependency and no model.
 *
 * WHAT AN EMBEDDING ACTUALLY IS
 *
 * One sentence from 1957: you know a word by the company it keeps. Count how
 * often each term appears in each context and you have a term-context matrix;
 * each ROW of it is already a vector for that term. Factorise the matrix down
 * to a few hundred dimensions and terms that keep similar company collapse
 * onto nearby vectors -- including terms that never co-occur directly, because
 * they share neighbours. That last part is the whole value, and it is the one
 * thing lexical matching cannot do.
 *
 * LSA did exactly this in 1988 with plain SVD. word2vec swapped the SVD for a
 * shallow network in 2013; GloVe factorises the log co-occurrence matrix.
 * Transformers add context-sensitivity. The principle never changed, and none
 * of it requires a downloaded model -- this file implements the 1988 version
 * in about a hundred lines:
 *
 *   A = term-document matrix, tf-idf weighted        (T x D)
 *   C = A^T A                                        (D x D, small)
 *   V, lambda = eigendecomposition of C by Jacobi rotation
 *   U = A V S^-1                                     term vectors
 *
 * WHAT THE SPECTRUM TELLS YOU
 *
 * The singular values are the answer. A corpus with real latent structure has
 * a steep spectrum -- a few large values carrying most of the variance, which
 * is exactly the low-dimensional structure a truncated factorisation captures.
 * A flat spectrum means every document is its own dimension and there is
 * nothing to compress; truncating then destroys information rather than
 * revealing any.
 *
 * MEASURED ON THIS CORPUS, 2026-09-01, 31 findings and ~10,000 tokens:
 *
 *   sigma1/sigma8       1.54x        (real latent structure shows 10x or more)
 *   LSA k=5             P@1 0.409
 *   LSA k=20            P@1 0.758
 *   LSA k=30            P@1 0.864    identical to plain tf-idf cosine
 *   plain tf-idf cosine P@1 0.864
 *
 * Every actual reduction hurts, and at full rank the "embedding" reproduces
 * cosine similarity exactly -- which is the check that the implementation is
 * correct, and simultaneously the proof that no semantic generalisation is
 * happening. Fusing LSA with the real retriever was simulated and gains one
 * case out of 66, only at full rank, well inside a standard error of 0.042.
 *
 * The conclusion is about the DATA, not the method: 31 findings deliberately
 * about 31 different things do not share latent dimensions, and ~10,000 tokens
 * is roughly a thousandth of what the smallest usable word2vec run consumes.
 *
 * SO RUN THIS AGAIN AS THE CORPUS GROWS. The verdict will change, and this is
 * the instrument that says when -- far cheaper than taking the dependency and
 * finding out.
 */
import { loadCorpus } from '../src/lib/cairn/load';
import { buildIndex, tokenize, docTerms } from '../src/lib/cairn/retrieval';
import { heldOutCases } from '../src/lib/cairn/evalset';

const all = loadCorpus();
const ix = buildIndex(all);
const D = ix.docs.length;
const termRow = new Map<string, number>();
for (const t of ix.termId.keys()) termRow.set(t, termRow.size);
const T = termRow.size;

const A = new Float64Array(T * D);
for (let d = 0; d < D; d++) {
  for (const [t, tf] of docTerms(ix, d)) {
    const df = ix.df.get(t) ?? 0;
    if (df <= 0) continue;
    A[termRow.get(t)! * D + d] = (1 + Math.log(tf)) * Math.log((D + 1) / df);
  }
}

const C: number[][] = Array.from({ length: D }, () => new Array(D).fill(0));
for (let i = 0; i < D; i++) {
  for (let j = i; j < D; j++) {
    let s = 0;
    for (let t = 0; t < T; t++) s += A[t * D + i] * A[t * D + j];
    C[i][j] = s; C[j][i] = s;
  }
}

/** Jacobi eigendecomposition of a symmetric matrix. Exact, iterative, tiny. */
function jacobi(M: number[][], sweeps = 100) {
  const n = M.length;
  const a = M.map((r) => r.slice());
  const V: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let s = 0; s < sweeps; s++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += a[i][j] * a[i][j];
    if (off < 1e-12) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(a[p][q]) < 1e-14) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), sn = t * c;
      for (let k = 0; k < n; k++) {
        const kp = a[k][p], kq = a[k][q];
        a[k][p] = c * kp - sn * kq; a[k][q] = sn * kp + c * kq;
      }
      for (let k = 0; k < n; k++) {
        const pk = a[p][k], qk = a[q][k];
        a[p][k] = c * pk - sn * qk; a[q][k] = sn * pk + c * qk;
      }
      for (let k = 0; k < n; k++) {
        const kp = V[k][p], kq = V[k][q];
        V[k][p] = c * kp - sn * kq; V[k][q] = sn * kp + c * kq;
      }
    }
  }
  return a.map((r, i) => ({ val: r[i], vec: V.map((row) => row[i]) }))
    .sort((x, y) => y.val - x.val);
}

const eig = jacobi(C);
const sv = eig.map((e) => Math.sqrt(Math.max(0, e.val)));

function lsaP1(k: number): number {
  const S = eig.slice(0, k).map((e) => Math.sqrt(Math.max(1e-9, e.val)));
  const Vk = eig.slice(0, k).map((e) => e.vec);
  const U = new Float64Array(T * k);
  for (let t = 0; t < T; t++) for (let i = 0; i < k; i++) {
    let s = 0;
    for (let d = 0; d < D; d++) s += A[t * D + d] * Vk[i][d];
    U[t * k + i] = s / S[i];
  }
  const docVec = Array.from({ length: D }, (_, d) =>
    Array.from({ length: k }, (_, i) => Vk[i][d] * S[i]));
  const norm = (v: number[]) => Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  const dn = docVec.map(norm);
  let p1 = 0, n = 0;
  for (const c of heldOutCases(all)) {
    const q = new Array(k).fill(0);
    for (const tok of tokenize(c.q)) {
      const r = termRow.get(tok.text);
      const df = ix.df.get(tok.text) ?? 0;
      if (r === undefined || df <= 0) continue;
      const w = Math.log((D + 1) / df);
      for (let i = 0; i < k; i++) q[i] += U[r * k + i] * w;
    }
    const qn = norm(q);
    let best = -1, bs = -Infinity;
    for (let d = 0; d < D; d++) {
      let dot = 0;
      for (let i = 0; i < k; i++) dot += q[i] * docVec[d][i];
      const sc = dot / (qn * dn[d]);
      if (sc > bs) { bs = sc; best = d; }
    }
    n++;
    if (ix.docs[best].finding.id === c.gold) p1++;
  }
  return p1 / n;
}

const decay = sv[0] / (sv[Math.min(7, sv.length - 1)] || 1);
console.log(`\nCAN THIS CORPUS SUPPORT EMBEDDINGS?`);
console.log('='.repeat(56));
console.log(`  ${T} terms x ${D} documents`);
console.log(`  singular values: ${sv.slice(0, 8).map((x) => x.toFixed(1)).join(' ')}`);
console.log(`  spectrum decay sigma1/sigma8: ${decay.toFixed(2)}x`);
console.log(`\n  LSA accuracy by retained dimensions:`);
for (const k of [5, 10, 20, Math.max(1, D - 1)]) {
  console.log(`    k=${String(k).padStart(3)}   P@1 ${lsaP1(k).toFixed(3)}${k >= D - 1 ? '   (full rank = plain cosine)' : ''}`);
}
console.log('\n' + '='.repeat(56));
if (decay < 3) {
  console.log('VERDICT: no low-dimensional structure to exploit.');
  console.log('Every document is close to its own dimension, so truncating the');
  console.log('factorisation destroys information rather than revealing any.');
  console.log('Embeddings would not help this corpus yet. Re-run as it grows.');
} else {
  console.log('VERDICT: the spectrum has real structure. A dense retriever may');
  console.log('now be worth the dependency — measure it against cairn:quick.');
}
console.log();
