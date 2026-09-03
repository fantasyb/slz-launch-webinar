/**
 * Sleep harvests surprise gaps from a transcript. These pin the invariants that
 * hold regardless of tuning — NOT a target count on any real transcript, because
 * fitting the gate to one session's number is the overfitting this project
 * refuses. What must be true: the trace parses, a model update is caught, a clean
 * session is silent, an unreasoned error stays below threshold (cairn-0045), and
 * the structural contradiction signal does not fire on shell tools (the firehose
 * measured on a real coding transcript, ~18% of turns, that this scoping cut).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscript, detectCandidates } from '../src/lib/cairn/sleep';

/** Build a JSONL transcript from a compact spec. */
function jsonl(events: object[]): string {
  return events.map((e) => JSON.stringify({ message: e })).join('\n');
}
const asst = (...content: object[]) => ({ role: 'assistant', content });
const user = (...content: object[]) => ({ role: 'user', content });
const say = (text: string) => ({ type: 'text', text });
const call = (id: string, name: string, input: object) => ({ type: 'tool_use', id, name, input });
const result = (id: string, content: string, isError = false) => ({ type: 'tool_result', tool_use_id: id, content, is_error: isError });

test('parseTranscript pairs a tool call with its result', () => {
  const turns = parseTranscript(jsonl([asst(call('x1', 'query_records', { object: 'Contact' })), user(result('x1', '{"records":[1]}'))]));
  const toolTurn = turns.find((t) => t.tool);
  assert.equal(toolTurn?.tool?.name, 'query_records');
  assert.equal(toolTurn?.result?.text, '{"records":[1]}');
  assert.equal(toolTurn?.result?.isError, false);
});

test('a model update after a result is a surprise gap', () => {
  const turns = parseTranscript(
    jsonl([
      asst(say('I expect this to return the churned contacts.'), call('a1', 'query_records', { object: 'Contact' })),
      user(result('a1', '{"records":[]}')),
      asst(say('Zero rows — actually it turns out the MCP bound to the wrong org and returned empty instead of erroring.')),
    ]),
  );
  const c = detectCandidates(turns);
  assert.equal(c.length, 1, 'the model update is caught');
  assert.equal(c[0].tool, 'query_records');
  assert.match(c[0].update, /wrong org/, 'the mechanism comes from the agent\'s own words');
  assert.ok(c[0].surprisal >= 3, 'a model update clears the gate on its own');
});

test('a clean session with no model update is silent', () => {
  const turns = parseTranscript(
    jsonl([
      asst(say('Listing objects.'), call('b1', 'list_objects', {})),
      user(result('b1', '{"objects":["Contact","Case"]}')),
      asst(say('Two objects, as expected. Moving on.')),
    ]),
  );
  assert.deepEqual(detectCandidates(turns), [], 'no surprise, no candidate');
});

test('an error the agent never reasoned about stays below threshold (cairn-0045)', () => {
  const turns = parseTranscript(
    jsonl([
      asst(call('c1', 'query_records', { object: 'Contact' })),
      user(result('c1', 'ECONNRESET', true)),
      asst(say('Retrying.')),
    ]),
  );
  assert.deepEqual(detectCandidates(turns), [], 'a loud error alone is the cheap class, not a finding');
});

test('the structural contradiction signal does not fire on shell tools', () => {
  /* Bash: {command} then {command,description} looks like an arg superset, and a
   * short output then a long one looks like empty-then-rows. On a real transcript
   * this fired on ~18% of turns. It must not. */
  const turns = parseTranscript(
    jsonl([
      asst(call('d1', 'Bash', { command: 'ls' })),
      user(result('d1', '')),
      asst(call('d2', 'Bash', { command: 'ls -la', description: 'long listing' })),
      user(result('d2', 'total 8\ndrwxr-xr-x')),
    ]),
  );
  assert.deepEqual(detectCandidates(turns), [], 'a longer shell command is not a query contradiction');
});

test('empty-then-superset on a real query tool IS a contradiction', () => {
  const turns = parseTranscript(
    jsonl([
      asst(call('e1', 'query_records', { object: 'Case' })),
      user(result('e1', '{"records":[]}')),
      asst(call('e2', 'query_records', { object: 'Case', org: 'prod' })),
      user(result('e2', '{"records":[1,2,3]}')),
    ]),
  );
  const c = detectCandidates(turns);
  assert.equal(c.length, 1, 'the silent-scope trap is caught even with no error and no prose');
  assert.match(c[0].reasons.join(' '), /returned empty; this superset returned rows/);
});
