/**
 * The check gate: does a check distinguish the trap from its absence?
 *
 * doctor reports a finding LIVE when its check exits zero, so the report is
 * only information if the check exits differently when the trap is gone.
 * Across the first forty findings, four of nineteen runnable checks managed
 * that -- all written by an agent with the schema in front of it, which makes
 * it the one measured failure mode of agent-written findings and the one a
 * machine can settle without trusting the author.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gate, deltaPlan } from '../src/lib/cairn/gate';
import { checkFlaws } from '../src/lib/cairn/checkquality';
import type { Finding } from '../src/lib/cairn/schema';
import fs from 'fs';
import os from 'os';
import path from 'path';

const base = {
  title: 't', claim: 'c', kind: 'trap', scope: 'environment-specific', appliesTo: 'here',
  tags: [], cost: 'hours', expectation: 'e', reality: 'r', evidence: [],
  provenance: 'firsthand', halfLifeDays: 180, observations: [], predictions: [],
  status: 'active', createdAt: new Date().toISOString(),
  subject: { name: 'n', ecosystem: 'e', versions: '*' },
} as unknown as Finding;

const withCheck = (id: string, command: string, absentWhen?: string) =>
  ({ ...base, id, check: { command, confirmedIf: 'a', refutedIf: 'b', manual: false, absentWhen } }) as Finding;

/*
 * A FILE-based trap, not an environment one, and that is a consequence worth
 * knowing rather than a detail of the test.
 *
 * Checks run with an allowlisted environment — PATH, HOME, the proxy and CA
 * variables — so a check cannot read an arbitrary variable and a delta cannot
 * unset one that was never visible. The first version of this test set
 * CAIRN_TEST_TRAP and asserted the gate saw it, which passed only while
 * checks inherited every secret in the shell.
 *
 * So: a trap that lives in an environment variable outside the allowlist
 * cannot be gated. That is a real capability lost to the scrub, taken
 * knowingly — the alternative is every check seeing every credential — and
 * traps about the proxy variables, which is the class this corpus actually
 * holds, are unaffected because those are allowlisted.
 */
test('a check that tests the trap discriminates; one that prints does not', async () => {
  const marker = path.join(os.tmpdir(), `cairn-trap-${process.pid}`);
  fs.writeFileSync(marker, 'present');
  try {
    const real = await gate(withCheck('t-1', `test -f ${marker}`, `rm -f ${marker}`));
    assert.equal(real.verdict, 'discriminates', real.detail);
    assert.equal(real.live, 0);
    assert.notEqual(real.absent, 0);

    // Same trap, same delta, a command that succeeds either way. This is the
    // shape of most checks in the corpus and the reason the gate exists.
    fs.writeFileSync(marker, 'present');
    const fake = await gate(withCheck('t-2', `ls ${marker} >/dev/null 2>&1; true`, `rm -f ${marker}`));
    assert.equal(fake.verdict, 'same-either-way', fake.detail);
  } finally {
    fs.rmSync(marker, { force: true });
  }
});

test('a shell-sabotaging absentWhen is an error, never discrimination', async () => {
  /* An always-zero check paired with a delta that just breaks the shell would
   * otherwise "discriminate" — the exact self-confirming check the gate exists
   * to catch. exit N, unset PATH, PATH=, set -e must all be refused. */
  for (const delta of ['exit 1', 'unset PATH', 'PATH=/nonexistent', 'set -e; false']) {
    const g = await gate(withCheck(`sab-${delta.replace(/\W+/g, '')}`, 'true', delta));
    assert.equal(g.verdict, 'error', `${delta} -> ${g.verdict}: ${g.detail}`);
  }
});

test('a delta that fails to apply is an error, not a discrimination', async () => {
  /* The check exits 0 with the trap present; the delta is a command that does
   * not exist, so trap-removal fails. That must be error (could not decide),
   * not "discriminates". */
  const g = await gate(withCheck('deltafail', 'true', 'this-command-does-not-exist-cairn'));
  assert.equal(g.verdict, 'error', g.detail);
});

test('the delta is on this machine, so a check that reads only the repo is refused', async () => {
  const marker = path.join(os.tmpdir(), `cairn-inc-${process.pid}`);
  fs.writeFileSync(marker, 'present');
  try {
    /*
     * The failure a two-MACHINE gate cannot catch. This greps a file that
     * exists in the checkout and has nothing to do with the trap. On a second
     * machine it would exit differently because the repository is absent, and
     * a two-machine gate would read that as discrimination. Changing one
     * variable on one machine cannot be fooled: the repository did not move.
     */
    const incidental = await gate(
      withCheck('t-3', 'test -f package.json', `rm -f ${marker}`),
    );
    assert.equal(incidental.verdict, 'same-either-way', incidental.detail);
  } finally {
    fs.rmSync(marker, { force: true });
  }
});

test('an env precondition negates mechanically; cmd and path do not', () => {
  assert.equal(deltaPlan({ ...base, check: { command: 'x', confirmedIf: 'a', refutedIf: 'b', manual: false }, precondition: ['env:HTTPS_PROXY'] } as Finding), 'unset HTTPS_PROXY');
  // Removing a binary from PATH to satisfy a gate is a side effect on
  // somebody's machine. No delta is the honest answer.
  assert.equal(deltaPlan({ ...base, check: { command: 'x', confirmedIf: 'a', refutedIf: 'b', manual: false }, precondition: ['cmd:rg', 'os:linux'] } as Finding), null);
});

test('the static rules catch what never decides, and pass what does', () => {
  // Real checks from the corpus, by shape.
  assert.ok(checkFlaws({ command: 'curl -sS x; echo "exit=$?"', confirmedIf: 'a', refutedIf: 'b', manual: false }).length);
  assert.ok(checkFlaws({ command: "df -h . | tail -1 | awk '{print $4}'", confirmedIf: 'a', refutedIf: 'b', manual: false }).length);
  assert.ok(checkFlaws({ command: 'node -e "console.log(ok?1:2)"', confirmedIf: 'a', refutedIf: 'b', manual: false }).length);
  // cairn-0005's shape: prints freely, then exits on the verdict.
  assert.equal(
    checkFlaws({ command: 'node -e "console.log(x); process.exit(leaked.length>0?0:1)"', confirmedIf: 'a', refutedIf: 'b', manual: false }).length,
    0,
  );
  // A manual check is outside the gate rather than failing it.
  assert.equal(checkFlaws({ command: 'Ask the operator whether billing is enabled', confirmedIf: 'a', refutedIf: 'b', manual: true }).length, 0);
});

/**
 * The `tool` field is what turns a recorded finding into a delivered one.
 *
 * A finding about an MCP tool's behaviour is entered by USING the tool, not
 * by an error you can paste afterwards, so it has to arrive when the agent
 * reaches for it. That is preflight, matching on triggers — so `tool` must
 * become a trigger, or the finding is only ever found by searching, and
 * cairn-0035 is the measurement that agents do not search.
 */
test('a tool-scoped submission becomes a preflight trigger', async () => {
  const { normalise } = await import('../src/lib/cairn/submission');
  const { preflight } = await import('../src/lib/cairn/retrieval');
  const { FindingSchema } = await import('../src/lib/cairn/schema');

  const submission = {
    title: 'the query tool returns empty rather than erroring on a stale mapping',
    claim: 'a stale mapping yields an empty result set with a success status, so no rows is indistinguishable from a broken mapping',
    expectation: 'a stale mapping surfaces as an error',
    reality: 'the call succeeds and returns zero rows',
    tool: 'mcp__data360__query_records',
    check: { command: 'Compare against a mapping known to be current', confirmedIf: 'zero rows with success', refutedIf: 'an error', manual: true },
    by: 'test',
    evidence: [{ command: 'query_records({object:"Account"})', output: '{"status":"success","records":[]}' }],
    tags: [], kind: 'trap' as const, cost: 'hours' as const,
  };

  const f = FindingSchema.parse(normalise(submission, new Date(), 'cairn-9001').finding);
  assert.deepEqual(f.triggers, ['mcp__data360__query_records']);
  assert.equal(f.subject.ecosystem, 'mcp');

  const warned = preflight('mcp__data360__query_records', [f], { useLocalEnvironment: false });
  assert.equal(warned.length, 1, 'reaching for the tool must surface the finding');
  // And nothing else: a hook that speaks on every tool call is one people skip.
  assert.equal(preflight('mcp__slack__post_message', [f], { useLocalEnvironment: false }).length, 0);
});

/**
 * An agent with nobody to tell it to bank must be told by the ledger.
 *
 * "Bank that" needs a person who noticed they struggled. An autonomous agent
 * has nobody, and asking it to introspect is the weakest available trigger:
 * having just solved something is exactly the state in which it does not feel
 * hard. The ledger holds a better signal recorded by a mechanism with no
 * opinion — a search the corpus could not usefully answer.
 *
 * The shape of that signal is the whole test. Keyed on an EMPTY result it
 * would never fire: retrieve returns weak matches for nearly any text, so two
 * queries about tools this corpus knows nothing about still came back with
 * five weak hits each. "No strong match" is the corpus's own word for having
 * nothing worth handing over, and it is the same judgement `brief` uses.
 */
test('a hole is no strong match, not an empty result', async () => {
  const { retrieve } = await import('../src/lib/cairn/retrieval');
  const { loadCorpus } = await import('../src/lib/cairn/load');
  const corpus = loadCorpus();

  /*
   * A subject this corpus will never cover, rather than one it does not
   * cover YET.
   *
   * This used to ask about a Data 360 mapping returning success with zero
   * rows, on the reasoning that nothing here knew about it. Then cairn-0045
   * was recorded, describing exactly that shape, and the query started
   * matching strongly — so the test failed because the corpus had LEARNED
   * something, which is the one thing it must never punish. A test whose
   * premise is the corpus's ignorance expires the moment the corpus is
   * useful, and it expires by failing, which reads as a regression.
   */
  const hits = retrieve('the sourdough starter did not rise in a cold kitchen', corpus, { limit: 5 });
  assert.ok(hits.length > 0, 'the retriever returns weak matches for almost anything');
  assert.ok(
    hits.every((h) => h.strength === 'weak'),
    'nothing here is about baking, so nothing should come back strong',
  );
});
