/**
 * The arc memory: three answers, three lifetimes, and the tally that is the
 * detector's calibration.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-arcs-'));
process.env.CAIRN_ARCS = path.join(dir, 'arcs.jsonl');

test('a slip is muted for a week, an expected failure for ninety days, and three of those mute the program', async () => {
  const { arcId, recordArc, muted, LIFETIME_DAYS } = await import('../src/lib/cairn/arcs');
  const key = 'sf agent';
  const slip = 'sf agent publish --nmae Demo';
  assert.equal(muted(key, slip), null, 'nothing remembered yet');
  recordArc({ arc: arcId(key, slip), key, failing: slip, choice: 'offered' });
  assert.equal(muted(key, slip), null, 'an offer alone mutes nothing');
  recordArc({ arc: arcId(key, slip), key, failing: slip, choice: 'my-mistake' });
  assert.match(muted(key, slip)!, /^my-mistake on/);
  assert.equal(muted(key, 'sf agent publish --name Other'), null, 'a different failing command is a different arc');
  const eightDays = new Date(Date.now() + (LIFETIME_DAYS['my-mistake'] + 1) * 86_400_000);
  assert.equal(muted(key, slip, eightDays), null, 'a slip is forgotten after a week');

  for (const c of ['sf agent preview -a', 'sf agent preview -b', 'sf agent preview -c']) recordArc({ arc: arcId(key, c), key, failing: c, choice: 'not-surprising' });
  assert.match(muted(key, 'sf agent anything else at all')!, /not surprising 3 times on `sf agent`/, 'three expected failures mute the program');
  assert.equal(muted('sf data', 'sf data query'), null, 'but not another program');
  const hundredDays = new Date(Date.now() + 100 * 86_400_000);
  assert.equal(muted(key, 'sf agent anything else at all', hundredDays), null, 'and that is forgotten after ninety days');
});

test('the tally counts every offer, every answer, and the offers nobody answered', async () => {
  const { arcId, recordArc, tally } = await import('../src/lib/cairn/arcs');
  const before = tally();
  recordArc({ arc: arcId('git push', 'git push origin x'), key: 'git push', failing: 'git push origin x', choice: 'offered' });
  recordArc({ arc: arcId('git push', 'git push origin x'), key: 'git push', failing: 'git push origin x', choice: 'bank' });
  recordArc({ arc: arcId('npm run', 'npm run nope'), key: 'npm run', failing: 'npm run nope', choice: 'offered' });
  const after = tally();
  assert.equal(after.offered - before.offered, 2);
  assert.equal(after.bank - before.bank, 1);
  assert.equal(after.unanswered - before.unanswered, 1, 'the npm arc was offered and never answered');
});
