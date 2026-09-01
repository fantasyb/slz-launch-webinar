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

const base = {
  title: 't', claim: 'c', kind: 'trap', scope: 'environment-specific', appliesTo: 'here',
  tags: [], cost: 'hours', expectation: 'e', reality: 'r', evidence: [],
  provenance: 'firsthand', halfLifeDays: 180, observations: [], predictions: [],
  status: 'active', createdAt: new Date().toISOString(),
  subject: { name: 'n', ecosystem: 'e', versions: '*' },
} as unknown as Finding;

const withCheck = (id: string, command: string, absentWhen?: string) =>
  ({ ...base, id, check: { command, confirmedIf: 'a', refutedIf: 'b', manual: false, absentWhen } }) as Finding;

test('a check that tests the trap discriminates; one that prints does not', async () => {
  process.env.CAIRN_TEST_TRAP = '1';
  try {
    const real = await gate(withCheck('t-1', '[ -n "$CAIRN_TEST_TRAP" ]', 'unset CAIRN_TEST_TRAP'));
    assert.equal(real.verdict, 'discriminates', real.detail);
    assert.equal(real.live, 0);
    assert.notEqual(real.absent, 0);

    // Same trap, same delta, a command that succeeds either way. This is the
    // shape of most checks in the corpus and the reason the gate exists.
    const fake = await gate(withCheck('t-2', 'echo "$CAIRN_TEST_TRAP"', 'unset CAIRN_TEST_TRAP'));
    assert.equal(fake.verdict, 'same-either-way', fake.detail);
  } finally {
    delete process.env.CAIRN_TEST_TRAP;
  }
});

test('the delta is on this machine, so a check that reads only the repo is refused', async () => {
  process.env.CAIRN_TEST_TRAP = '1';
  try {
    /*
     * The failure a two-MACHINE gate cannot catch. This greps a file that
     * exists in the checkout and has nothing to do with the trap. On a second
     * machine it would exit differently because the repository is absent, and
     * a two-machine gate would read that as discrimination. Changing one
     * variable on one machine cannot be fooled: the repository did not move.
     */
    const incidental = await gate(
      withCheck('t-3', 'test -f package.json', 'unset CAIRN_TEST_TRAP'),
    );
    assert.equal(incidental.verdict, 'same-either-way', incidental.detail);
  } finally {
    delete process.env.CAIRN_TEST_TRAP;
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
