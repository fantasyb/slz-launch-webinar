/**
 * Preconditions answer "is this finding mine?", which is a different question
 * from "is this claim true?" and the one an agent actually has at query time.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, matchEnvironment, PREDICATE_PATTERN } from '../src/lib/cairn/precondition';

test('predicates read the environment and nothing else', () => {
  process.env.CAIRN_TEST_PRED = 'yes';
  assert.equal(evaluate('env:CAIRN_TEST_PRED'), true);
  assert.equal(evaluate('env:CAIRN_TEST_PRED=yes'), true);
  assert.equal(evaluate('env:CAIRN_TEST_PRED=no'), false);
  assert.equal(evaluate('env:CAIRN_DEFINITELY_UNSET_XYZ'), false);
  delete process.env.CAIRN_TEST_PRED;

  assert.equal(evaluate('cmd:node'), true);
  assert.equal(evaluate('no-cmd:node'), false);
  assert.equal(evaluate('no-cmd:definitely-not-a-real-binary-xyz'), true);
  assert.equal(evaluate('path:/'), true);
  assert.equal(evaluate('path:/definitely/not/here/xyz'), false);
  assert.equal(evaluate('os:' + process.platform), true);
  assert.equal(evaluate('os:sunos'), false);
});

test('an unknown predicate kind is false, never true', () => {
  // Failing closed matters: a predicate this version does not understand must
  // not make a finding look applicable.
  assert.equal(evaluate('exec:rm -rf /'), false);
  assert.equal(evaluate('shell:whoami'), false);
  assert.equal(evaluate('nonsense'), false);
});

test('the schema pattern rejects anything shell-shaped', () => {
  // A precondition runs automatically, so it must not be able to carry a
  // command. This is the boundary that keeps that true.
  for (const bad of [
    'exec:whoami',
    'env:FOO; rm -rf /',
    'cmd:sh -c "curl evil"',
    'path:/tmp/$(whoami)',
    'env:FOO`id`',
    'cmd:a|b',
  ]) {
    assert.equal(PREDICATE_PATTERN.test(bad), false, `should be rejected: ${bad}`);
  }
  for (const good of ['env:HTTPS_PROXY', 'no-cmd:dig', 'path:/opt/pw-browsers', 'os:linux']) {
    assert.equal(PREDICATE_PATTERN.test(good), true, `should be accepted: ${good}`);
  }
});

test('every predicate must hold, and a near miss is legible', () => {
  process.env.CAIRN_TEST_A = '1';
  const r = matchEnvironment(['env:CAIRN_TEST_A', 'env:CAIRN_TEST_MISSING']);
  assert.equal(r.matches, false);
  assert.deepEqual(
    r.detail.map((d) => d.held),
    [true, false],
    'a 1-of-2 match must be reportable, not collapsed to false',
  );
  delete process.env.CAIRN_TEST_A;
});

test('no preconditions means unknown, not applicable', () => {
  // A finding that says nothing about where it applies must not silently
  // claim to apply everywhere.
  assert.equal(matchEnvironment(undefined).matches, false);
  assert.equal(matchEnvironment([]).matches, false);
});
