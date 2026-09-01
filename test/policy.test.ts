/**
 * Execution is off unless a committed file says otherwise.
 *
 * A check is arbitrary shell that came out of a corpus. Everything else in
 * this project is inert — retrieval reads JSON and ranks it — so this is the
 * entire security surface, and it was opt-in BY CODE: `find --confirm` needed
 * a flag and `doctor` needed nothing at all. A flag is a decision made in the
 * moment by whoever types the command. It is not something an organisation
 * can disable for a repository, point a reviewer at, or audit afterwards.
 *
 * Each case runs in its own process. cairnHome() memoises for the lifetime of
 * a process — deliberately, since a corpus does not move mid-run — so a test
 * that sets CAIRN_HOME between cases in one process measures only the first
 * value it happened to set. The first version of this file did exactly that
 * and passed two cases while silently testing one home.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const REPO = process.cwd();

/**
 * Evaluate an expression against a corpus whose MACHINE policy is `body`.
 *
 * The policy is keyed by corpus path in a file outside the corpus, so the
 * test writes it outside too. A version of this that wrote it into the corpus
 * would pass while testing the design that shipped execution enabled to
 * everyone who cloned this repository.
 */
function inCorpus(body: string | null, expr: string, opts: { alsoInCorpus?: string } = {}): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-policy-'));
  fs.mkdirSync(path.join(home, 'cairn'));
  const policyFile = path.join(home, 'machine-policy.json');
  if (body !== null) fs.writeFileSync(policyFile, body.replace('__CORPUS__', home));
  if (opts.alsoInCorpus) fs.writeFileSync(path.join(home, 'cairn.policy.json'), opts.alsoInCorpus);
  return execFileSync(
    'npx',
    ['tsx', '-e', `import {executionPolicy, assertExecutionAllowed, ExecutionRefused} from './src/lib/cairn/policy';${expr}`],
    { cwd: REPO, env: { ...process.env, CAIRN_HOME: home, CAIRN_POLICY: policyFile }, encoding: 'utf8' },
  ).trim();
}

test('no policy file means execution is refused', () => {
  assert.equal(inCorpus(null, 'console.log(executionPolicy().enabled)'), 'false');
  assert.equal(
    inCorpus(null, 'try{assertExecutionAllowed("checks");console.log("ALLOWED")}catch(e){console.log(e instanceof ExecutionRefused?"REFUSED":"OTHER")}'),
    'REFUSED',
  );
});

test('the refusal names the file and the key, because it is an instruction', () => {
  const msg = inCorpus(null, 'try{assertExecutionAllowed("checks from the corpus")}catch(e){console.log(e.message)}');
  // The file actually consulted, which under CAIRN_POLICY is not the default path.
    assert.match(msg, /policy\.json/);
  assert.match(msg, /"enabled": true/);
  // Someone who cannot enable it still needs to know what does work without it.
  assert.match(msg, /search, brief, sync, record/);
});

test('a machine policy naming this corpus enables it', () => {
  const p = '{"__CORPUS__":{"enabled":true}}';
  assert.equal(inCorpus(p, 'console.log(executionPolicy().enabled)'), 'true');
  assert.equal(
    inCorpus(p, 'try{assertExecutionAllowed("checks");console.log("ALLOWED")}catch{console.log("REFUSED")}'),
    'ALLOWED',
  );
});

test('a policy naming a DIFFERENT corpus does not enable this one', () => {
  assert.equal(
    inCorpus('{"/some/other/corpus":{"enabled":true}}', 'console.log(executionPolicy().enabled)'),
    'false',
  );
});

test('a policy inside the corpus cannot enable execution', () => {
  /*
   * The defect this whole design exists to prevent, asserted directly. The
   * first version read cairn.policy.json from the corpus root, and the corpus
   * is a repository people clone — so this repository shipped
   * {"enabled": true} and turned execution on for every adopter by upstream's
   * decision, while EXECUTION.md claimed the opposite. `cairn-sync` runs
   * `git pull`, so upstream could also flip it later.
   */
  assert.equal(
    inCorpus(null, 'console.log(executionPolicy().enabled)', { alsoInCorpus: '{"enabled":true}' }),
    'false',
    'a file inside the corpus must never enable execution — it travels with the clone',
  );
});

test('a malformed policy is OFF, never on', () => {
  // The failure mode of guessing the other way is executing shell because
  // somebody's JSON had a trailing comma.
  for (const body of ['{"__CORPUS__":{"enabled":true},}', 'not json at all', '{"__CORPUS__":{"enabled":"yes"}}', '']) {
    assert.equal(
      inCorpus(body, 'console.log(executionPolicy().enabled)'),
      'false',
      `${JSON.stringify(body.slice(0, 24))} must not enable execution`,
    );
  }
});

test('strict additionally covers the check the caller just wrote', () => {
  // Off by default: `record` runs the check in the submission it is recording,
  // which the caller wrote seconds earlier. That is running your own code, and
  // gating it forfeits the one thing that makes a check verifiable rather than
  // merely runnable. `strict` exists for environments that draw no distinction.
  assert.equal(inCorpus('{"__CORPUS__":{"enabled":true}}', 'console.log(executionPolicy().strict)'), 'false');
  assert.equal(inCorpus('{"__CORPUS__":{"enabled":true,"strict":true}}', 'console.log(executionPolicy().strict)'), 'true');
});
