/**
 * The near-duplicate gate ate a real finding in a live session.
 *
 * It fires on two shared significant terms between titles, which collapsed
 * "an Agentforce agent does not appear in the panel" into "an agent does not
 * fire Apex" — both permission-set-shaped, different symptoms.
 *
 * What made that expensive was not the false positive. It was that the
 * override was named only for the CLI (`origin === 'human'`) and was absent
 * from the gateway's cairn_record schema entirely. The agent was refused, was
 * not told a door existed, and had none. Its transcript reads "I won't fight
 * the tool over it", and the finding went into a markdown runbook. The corpus
 * lost it and recorded nothing about having done so.
 *
 * So the property under test is not "the gate is smarter". It is that the
 * caller being refused can ACT on the refusal, and that doing so leaves a
 * reason behind — because a bare force flag would have unblocked it and
 * taught us nothing about how often this gate is wrong.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

/*
 * Before any import that resolves the corpus. cairnHome() memoises on first
 * use, so setting CAIRN_HOME inside a file whose other tests have already
 * resolved it does nothing and the writes land elsewhere — which is exactly
 * what happened while writing this test, for the second time today.
 */
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-dedup-'));
fs.mkdirSync(path.join(HOME, 'cairn'));
process.env.CAIRN_HOME = HOME;

const sub = (title: string, extra: Record<string, unknown> = {}) => ({
  title,
  claim:
    'A permission set assignment reports success while the thing it was meant to enable stays unavailable to the user.',
  expectation: 'Assigning the permission set makes the capability available.',
  reality: 'The assignment succeeds and the capability is still missing.',
  evidence: [{ command: 'assign the permission set', output: 'success' }],
  check: {
    command: 'Assign it, then check the capability by hand.',
    confirmedIf: 'still missing',
    refutedIf: 'available',
  },
  by: 'test-agent',
  ...extra,
});

test('a refused near-duplicate can be recorded by saying why it is different', async () => {
  const { recordSubmission } = await import('../src/lib/cairn/recordFinding');

  const first = await recordSubmission(
    sub('an agent does not fire Apex when the permission set is missing'),
    { origin: 'agent' },
  );
  assert.ok(first.ok, first.message);

  /* Same shape, different trap. The gate fires — and must say how to proceed. */
  const refused = await recordSubmission(
    sub('an agent does not appear in the panel when the permission set is missing'),
    { origin: 'agent' },
  );
  assert.equal(refused.ok, false, 'the premise: the gate still fires on this pair');
  assert.match(refused.message, /distinctFrom/, 'the refusal must name the remedy');
  assert.match(refused.message, /"id": "cairn-0001"/, 'and hand back the value that satisfies it');
  assert.ok(
    !/--force/.test(refused.message),
    'a CLI flag is not a remedy a tool caller can reach; it must not be the only one offered',
  );

  const accepted = await recordSubmission(
    sub('an agent does not appear in the panel when the permission set is missing', {
      distinctFrom: [
        {
          id: 'cairn-0001',
          because:
            'that one is about Apex not firing; this is about the agent never appearing in the panel at all',
        },
      ],
    }),
    { origin: 'agent' },
  );
  assert.ok(accepted.ok, accepted.message);
  assert.equal(
    accepted.finding?.distinctFrom?.[0].id,
    'cairn-0001',
    'the reason is kept on the finding, so every override is a countable instance of the gate being wrong',
  );
  assert.equal(fs.readdirSync(path.join(HOME, 'cairn')).length, 2, 'both traps are in the corpus');
});
