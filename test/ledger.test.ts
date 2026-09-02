/**
 * Regression tests for the forecast ledger and the install-block origin.
 *
 * Same rule as scoring.test.ts: every case here is a defect that shipped.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreByModel,
  isScorableIn,
  isSelfPrediction,
  calibrationCurve,
  ledgerIntegrity,
} from '../src/lib/cairn/calibration';
import { pairwiseCorrelation } from '../src/lib/cairn/correlation';
import { resolveOrigin, resetOriginCache } from '../src/lib/cairn/origin';
import { findingBodyHash } from '../src/lib/cairn/signing';
import { finding } from './helpers';
import { loadCorpus } from '../src/lib/cairn/load';
import type { Finding } from '../src/lib/cairn/schema';
import { execFileSync } from 'child_process';
import os from 'os';
import fs from 'fs';
import path from 'path';

const seal = (by: string, at: string) => ({
  at,
  by,
  commitment: { algorithm: 'sha256' as const, hash: 'a'.repeat(64), anchor: 'abc1234' },
});

test('a sealed forecast is not abandoned until evidence arrives after the seal', () => {
  const fresh = finding({
    id: 'cairn-0100',
    observations: [{ at: '2026-08-30T12:00:00Z', by: 'author', verdict: 'confirmed' }] as never,
    predictions: [seal('honest', '2026-08-30T12:30:00Z')] as never,
  });
  assert.equal(
    scoreByModel([fresh]).find((s) => s.by === 'honest')?.abandoned ?? 0,
    0,
    'following step one of the protocol must not be penalised',
  );

  const settled = finding({
    id: 'cairn-0101',
    observations: [
      { at: '2026-08-30T12:00:00Z', by: 'author', verdict: 'confirmed' },
      { at: '2026-08-30T14:00:00Z', by: 'someone', verdict: 'refuted' },
    ] as never,
    predictions: [seal('withholder', '2026-08-30T12:30:00Z')] as never,
  });
  assert.equal(
    scoreByModel([settled]).find((s) => s.by === 'withholder')?.abandoned,
    1,
    'withholding a reveal after the check settled must still count',
  );
});

test('a forecast with no bodyHash is not scored', () => {
  const f = finding({
    predictions: [
      {
        at: '2026-08-10T00:00:00Z',
        by: 'someone-else',
        outcome: 'confirmed',
        priorConfirmed: 0.9,
        reasoning: 'because',
        resolvedAt: '2026-08-20T00:00:00Z',
        commitment: { algorithm: 'sha256', hash: 'a'.repeat(64), anchor: 'abc1234' },
      },
    ] as never,
    observations: [{ at: '2026-08-01T00:00:00Z', by: 'author', verdict: 'confirmed' }] as never,
  });
  assert.equal(isScorableIn(f, f.predictions[0]), false);
});

test('a forecast bound to text that has since changed is not scored', () => {
  const base: Finding = finding({
    observations: [{ at: '2026-08-01T00:00:00Z', by: 'author', verdict: 'confirmed' }] as never,
  });
  const stale = finding({
    ...base,
    claim: 'a completely different claim, long enough to satisfy the schema minimum',
    predictions: [
      {
        at: '2026-08-10T00:00:00Z',
        by: 'someone-else',
        outcome: 'confirmed',
        priorConfirmed: 0.9,
        reasoning: 'because',
        resolvedAt: '2026-08-20T00:00:00Z',
        bodyHash: findingBodyHash(base),
        commitment: { algorithm: 'sha256', hash: 'a'.repeat(64), anchor: 'abc1234' },
      },
    ] as never,
  });
  assert.equal(isScorableIn(stale, stale.predictions[0]), false);
});

test('a forecast under the founding observation\'s own label is self-authored', () => {
  const f = finding({
    observations: [{ at: '2026-08-01T00:00:00Z', by: 'author', verdict: 'confirmed' }] as never,
    predictions: [{ at: '2026-08-10T00:00:00Z', by: 'author', priorConfirmed: 0.9 }] as never,
  });
  assert.equal(isSelfPrediction(f, f.predictions[0]), true);
});

test('relabelling is NOT prevented, and the corpus must not claim otherwise', () => {
  // Honest negative test. isSelfPrediction resolves the originator through the
  // signing key where one exists, but a prediction carries no key, so the
  // forecaster's own label is self-asserted. An earlier test titled itself
  // "cannot score their own forecast by relabelling" and then used the same
  // label on both sides, so it asserted nothing and passed.
  //
  // This documents the real boundary: binding predictions to keys is what
  // would close it, and until then the README says so.
  const f = finding({
    observations: [{ at: '2026-08-01T00:00:00Z', by: 'author', verdict: 'confirmed' }] as never,
    predictions: [{ at: '2026-08-10T00:00:00Z', by: 'author-alt', priorConfirmed: 0.9 }] as never,
  });
  assert.equal(
    isSelfPrediction(f, f.predictions[0]),
    false,
    'if this ever returns true, predictions became key-bound and the README needs updating',
  );
});

test('an outcome with no resolvedAt is not scorable', () => {
  // A hand-written reveal could copy the real preimage, keep the hash valid,
  // omit resolvedAt, and record the opposite outcome: lint skipped its
  // cross-check (gated on the same field) and a fabricated Brier reached the
  // training export.
  const base = finding({
    observations: [{ at: '2026-08-01T00:00:00Z', by: 'author', verdict: 'confirmed' }] as never,
  });
  const f = finding({
    ...base,
    predictions: [
      {
        at: '2026-08-10T00:00:00Z',
        by: 'someone-else',
        outcome: 'confirmed',
        priorConfirmed: 0.95,
        reasoning: 'because',
        bodyHash: findingBodyHash(base),
        commitment: { algorithm: 'sha256', hash: 'a'.repeat(64), anchor: 'abc1234' },
      },
    ] as never,
  });
  assert.equal(isScorableIn(f, f.predictions[0]), false);
});

test('ledgerIntegrity: self is orthogonal to the status partition', () => {
  // The homepage listed `self` beside `unanchored` as if they were
  // alternatives, so the reasons summed to twice the set they described.
  const l = ledgerIntegrity(loadCorpus());
  assert.equal(
    l.verified + l.sealed + l.broken + l.unanchored + l.legacyEncoding,
    l.total,
    'only these five partition the total',
  );
  assert.ok(
    l.self <= l.total,
    'self cuts across the partition and must never be added to it',
  );
});

test('empty calibration bins report null, never a perfect-looking zero', () => {
  const curve = calibrationCurve([finding()], 5);
  for (const b of curve) {
    if (b.n === 0) {
      assert.equal(b.predicted, null);
      assert.equal(b.actual, null);
    }
  }
});

test('a correlation is not reported from degenerate input', () => {
  const rows = [
    { errors: new Map([['a', 0.2], ['b', 0.3]]) },
    { errors: new Map([['a', 0.2], ['b', 0.3]]) },
    { errors: new Map([['a', 0.2], ['b', 0.3]]) },
  ] as never[];
  assert.equal(pairwiseCorrelation(rows, 'a', 'b'), null, 'zero variance is not a correlation');

  const tooFew = [{ errors: new Map([['a', 0.1], ['b', 0.9]]) }] as never[];
  assert.equal(pairwiseCorrelation(tooFew, 'a', 'b'), null);
});

test('the install block base never comes from the request Host', () => {
  const req = (host: string) => new Request('http://x/api/block', { headers: { host } });

  resetOriginCache();
  process.env.CAIRN_BASE_URL = 'https://cairn.example';
  const mismatched = resolveOrigin(req('evil.example'));
  assert.equal(mismatched.base, 'https://cairn.example', 'must serve the configured base');
  assert.equal(mismatched.canonical, false, 'must not be signable');

  resetOriginCache();
  const matched = resolveOrigin(req('cairn.example'));
  assert.equal(matched.canonical, true);

  resetOriginCache();
  delete process.env.CAIRN_BASE_URL;
});

test('ledgerIntegrity fields are internally consistent', () => {
  // The homepage twice stated something arithmetically impossible by pairing
  // fields that are not subsets of one another ("4 excluded — 5 of them").
  // These are the relationships prose is allowed to assume.
  const f = finding({
    observations: [{ at: '2026-08-01T00:00:00Z', by: 'author', verdict: 'confirmed' }] as never,
    predictions: [
      { at: '2026-08-10T00:00:00Z', by: 'author', priorConfirmed: 0.9 },
      seal('other', '2026-08-11T00:00:00Z'),
    ] as never,
  });
  const l = ledgerIntegrity([f]);

  assert.equal(
    l.verified + l.sealed + l.broken + l.unanchored + l.legacyEncoding,
    l.total,
    'status counts must partition the total',
  );
  assert.ok(l.scored <= l.total, 'scored cannot exceed recorded');
  assert.ok(l.self <= l.total, 'self cannot exceed recorded');
  assert.ok(
    l.scored + l.self <= l.total + l.scored,
    'self and scored are disjoint only if no self-prediction is scored',
  );
  // The one relationship the homepage depends on: excluded = total - scored,
  // and `self` is a reason for exclusion, never a superset of it.
  assert.ok(l.self <= l.total - l.scored, 'every self-prediction must be excluded');
});


test('the live corpus satisfies the same partition', () => {
  const l = ledgerIntegrity(loadCorpus());
  assert.equal(
    l.verified + l.sealed + l.broken + l.unanchored + l.legacyEncoding,
    l.total,
    'a status the real corpus carries but the synthetic fixture does not is exactly ' +
      'how this test passed while the homepage numbers stopped adding up',
  );
  assert.ok(l.self <= l.total - l.scored);
});

/**
 * A measurement must not record itself as usage.
 *
 * The eval suites replay eight scenarios thirty times each through the same
 * code path a person uses, and every row landed in the committed ledger
 * tagged `cli:find` — indistinguishable from somebody actually asking. 240 of
 * 273 rows were the test suite, and `cairn:status` reported them as adoption.
 * The only evidence of use in this project was generated by the project
 * testing itself.
 *
 * An instrument that records its own calibration runs as observations is
 * precisely the failure this corpus exists to catch, and it shipped here.
 */
test('CAIRN_EVAL keeps a measurement out of the usage ledger', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-eval-'));
  fs.mkdirSync(path.join(home, 'cairn'));
  fs.cpSync(path.join(process.cwd(), 'cairn'), path.join(home, 'cairn'), { recursive: true });

  const rows = () => {
    const f = path.join(home, 'data', 'retrievals');
    if (!fs.existsSync(f)) return 0;
    return fs
      .readdirSync(f)
      .reduce((n, x) => n + fs.readFileSync(path.join(f, x), 'utf8').split('\n').filter(Boolean).length, 0);
  };

  const find = (env: Record<string, string>) =>
    execFileSync('node', [path.join(process.cwd(), 'bin/cairn-find.js'), 'nslookup: not found'], {
      env: { ...process.env, CAIRN_HOME: home, ...env },
      encoding: 'utf8',
    });

  find({ CAIRN_EVAL: '1' });
  assert.equal(rows(), 0, 'a measurement run must write nothing');

  find({});
  assert.equal(rows(), 1, 'and an ordinary run must still be recorded');
});
