import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('controlled agent evaluation reproduces five covered failures and three unknowns', { timeout: 120000 }, async () => {
  const { stdout } = await promisify(execFile)(process.execPath,
    ['--import', 'tsx', 'research/scripts/agent-eval.ts', '--controlled'],
    { timeout: 110000, maxBuffer: 1 << 20, env: { ...process.env, CAIRN_EVAL: '1' } });
  assert.match(stdout, /CONTROLLED: real curl/);
  assert.match(stdout, /CONNECT tunnel failed, response 403/);
  assert.match(stdout, /dig: (?:command )?not found/);
  assert.equal((stdout.match(/^HIT/gm) ?? []).length, 5, stdout);
  assert.equal((stdout.match(/^QUIET/gm) ?? []).length, 3, stdout);
  assert.doesNotMatch(stdout, /^(?:MISS|NOISE)/m);
});
