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

test('an agent-recorded finding is born AGING, never fresh: one unsigned observer, one environment', async () => {
  const { recordSubmission } = await import('../src/lib/cairn/recordFinding');
  const { standing, confidence } = await import('../src/lib/cairn/decay');
  const r = await recordSubmission({ ...base, title: 'born-standing probe alpha' }, { origin: 'agent', by: 'claude-in-session' });
  assert.equal(r.ok, true, r.message);
  const f = r.finding!;
  assert.equal(f.provenance, 'firsthand', 'honest provenance: the agent saw it');
  assert.equal(f.scope, 'environment-specific', 'and claims only where it saw it');
  assert.equal(f.observations[0].environment?.os, process.platform, 'the recording machine is stamped when the submitter reported none');
  assert.match(f.observations[0].environment?.note ?? '', /submitter reported no environment/);
  assert.equal(standing(f), 'aging', 'served at once, but not as an established fact');
  const c = confidence(f);
  assert.ok(Math.abs(c - 0.45) < 0.01, `freshness 1.0 x (0.5 + 0.5 x 0) x scopeSupport 0.9 = 0.45, got ${c}`);
  assert.notEqual(standing(f), 'fresh');
});

test('a generic-reflex workaround is refused softly, and accepted with a stored reason', async () => {
  const { recordSubmission } = await import('../src/lib/cairn/recordFinding');
  const reflex = { ...base, title: 'timeout on first call of the uploader', workaround: 'Just retry the call; it works the second time.' };
  const r = await recordSubmission(reflex, { origin: 'agent' });
  assert.equal(r.ok, false);
  assert.match(r.message, /generic reflex \("retry"\)/);
  assert.match(r.message, /"reflexBecause": "<why a plain retry does not get past this>"/, 'the refusal names the exact field to send');
  assert.doesNotMatch(r.message, /--force/, 'an agent is not offered the CLI-only override');
  /* The reality field may SAY "retry" — that is the tool talking, not the reflex. */
  const toolSays = { ...base, title: 'uploader prints please repeat and never recovers', reality: 'It prints "please retry" on every call and never succeeds.' };
  assert.equal((await recordSubmission(toolSays, { origin: 'agent' })).ok, true, 'matched against workaround and mechanism only');
  const because = 'a plain retry hits the same warm cache; only a retry after clearing ~/.deploy-cache succeeds';
  const ok = await recordSubmission({ ...reflex, reflexBecause: because }, { origin: 'agent' });
  assert.equal(ok.ok, true, ok.message);
  assert.equal((ok.finding as { reflexBecause?: string }).reflexBecause, because, 'the override is stored, so its rate is countable');
});

test('a governed/agent submission cannot forge machine provenance, is private, and is marked non-executable', async () => {
  const { recordSubmission } = await import('../src/lib/cairn/recordFinding');
  const { isOperatorPromoted } = await import('../src/lib/cairn/confirm');
  // A tenant tries the cross-tenant forgery chain: claim the machine-observer
  // identity as author, ask to federate, plant a check. The gateway sets the
  // author itself, so the forged `by` is overridden — never honored.
  const ok = await recordSubmission(
    { ...base, title: 'a tenant trap about the deploy tool', by: 'doctor', share: true },
    { origin: 'agent', by: 'tenant-alice' },
  );
  assert.equal(ok.ok, true, ok.message);
  const f = ok.finding!;
  assert.equal(f.observations[0].by, 'tenant-alice', 'the forged "doctor" author is overridden with the gateway-set principal');
  assert.notEqual(f.observations[0].by, 'doctor', 'no machine-verified provenance for a tenant');
  assert.equal(f.visibility, 'private', 'a tenant finding is never shared to federation, even with share:true');
  assert.equal((f as { agentRecorded?: boolean }).agentRecorded, true, 'marked as agent-recorded');
  assert.equal(isOperatorPromoted(f), false, 'unpromoted: its check will be skipped by doctor/verify, not executed');
});
