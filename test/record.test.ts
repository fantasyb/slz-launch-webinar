/**
 * A refusal that makes a model guess is a refusal that costs three calls.
 *
 * Watched in a real session: a title over 120 characters, refused with the
 * bare bound, trimmed, refused again, shortened hard, accepted. Three round
 * trips through cairn_record in the middle of a failing deploy. Every bound
 * that can be satisfied mechanically now comes back with the value that
 * satisfies it, and this proves the value it hands back is accepted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-record-test-'));
fs.mkdirSync(path.join(home, 'cairn'));
process.env.CAIRN_HOME = home; /* before the first import resolves it */
process.env.CAIRN_POLICY = path.join(home, 'no-policy.json');

const base = {
  claim: 'A metadata deploy that names a region the template does not have fails naming the bad region and never the valid ones.',
  expectation: 'The error lists the regions the template accepts.',
  reality: 'It names the region it rejected and nothing else; the valid names are template-specific and undocumented.',
  workaround: 'Read the template source for the region names.',
  tool: 'deploy_metadata',
  evidence: [{ command: 'deploy_metadata {"path":"force-app"}', output: 'Invalid region name: sidebar' }],
  check: { command: 'Deploy a FlexiPage naming a region the template lacks and read the error.', confirmedIf: 'the error names only the rejected region', refutedIf: 'the error lists the valid regions' },
  by: 'test-agent',
};

test('an over-long title is refused once, with the count and a value that is then accepted', async () => {
  const { recordSubmission } = await import('../src/lib/cairn/recordFinding');
  const title = 'Lightning record page deploy fails with an invalid region name for recordHomeTemplateDesktop and the error never lists the valid region names for the template';
  const r = await recordSubmission({ ...base, title }, { origin: 'agent' });
  assert.equal(r.ok, false);
  assert.match(r.message, new RegExp(`title: ${title.length} characters; the limit is 120, so ${title.length - 120} over`));
  const suggested = /This fits and will be accepted as-is:\n\s+("[^\n]+")/.exec(r.message);
  assert.ok(suggested, r.message);
  const fixed = JSON.parse(suggested![1]) as string;
  assert.ok(fixed.length <= 120 && fixed.length > 80, `a title, not a fragment: ${fixed}`);
  assert.ok(!/\s$/.test(fixed) && !/[,;:—-]$/.test(fixed), 'cut at a word boundary, no dangling punctuation');
  const again = await recordSubmission({ ...base, title: fixed }, { origin: 'agent' });
  assert.equal(again.ok, true, again.message);
  assert.equal(again.finding!.title, fixed);
});

test('a short claim and a missing field say how much and what', async () => {
  const { recordSubmission } = await import('../src/lib/cairn/recordFinding');
  const r = await recordSubmission({ ...base, title: 'x', claim: 'It just fails.', by: undefined }, { origin: 'agent' });
  assert.equal(r.ok, false);
  assert.match(r.message, /claim: 14 characters; at least 40 needed, so 26 short/);
  assert.match(r.message, /by: missing — your model or agent name/);
});

test('a refused secret comes back with the redaction that would be accepted', async () => {
  const { recordSubmission } = await import('../src/lib/cairn/recordFinding');
  const r = await recordSubmission({ ...base, title: 'auth header leaks', evidence: [{ command: 'curl', output: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789' }] }, { origin: 'agent' });
  assert.equal(r.ok, false);
  assert.match(r.message, /auth-header: [^\n]*\n\s+accepted if written as "Bearer <redacted:credential>"/);
});
