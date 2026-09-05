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
      asst(say('I expect this to return the churned contacts.'), call('a1', 'mcp__sf__query_records', { object: 'Contact' })),
      user(result('a1', '{"records":[]}')),
      asst(say('Zero rows — actually it turns out the MCP bound to the wrong org and returned empty instead of erroring.')),
    ]),
  );
  const c = detectCandidates(turns);
  assert.equal(c.length, 1, 'the model update is caught');
  assert.equal(c[0].tool, 'mcp__sf__query_records');
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

test('a successful call followed by work-narration is not a model update', () => {
  /* The firehose the real test exposed: on a build transcript every assistant
   * turn is "Pushed / Done / Verified — actually ...", and the prose regex fired
   * on all of it (652 of 704 candidates). A plain successful call with a normal
   * payload gave the agent nothing to be surprised BY, so the prose after it is
   * narration about the agent's own work, not a model of the tool changing. */
  const turns = parseTranscript(
    jsonl([
      asst(call('f1', 'Bash', { command: 'git push' })),
      user(result('f1', 'branch updated -> origin/main')),
      asst(say('Pushed — 212 tests, guard passing. Actually it turns out the lint step was already green, instead of what I expected.')),
    ]),
  );
  assert.deepEqual(detectCandidates(turns), [], 'update-words in work-narration after a plain success do not clear the gate');
});

test('empty-then-superset on a real query tool IS a contradiction', () => {
  const turns = parseTranscript(
    jsonl([
      asst(call('e1', 'mcp__sf__query_records', { object: 'Case' })),
      user(result('e1', '{"records":[]}')),
      asst(call('e2', 'mcp__sf__query_records', { object: 'Case', org: 'prod' })),
      user(result('e2', '{"records":[1,2,3]}')),
    ]),
  );
  const c = detectCandidates(turns);
  assert.equal(c.length, 1, 'the silent-scope trap is caught even with no error and no prose');
  assert.match(c[0].reasons.join(' '), /returned empty; this superset returned rows/);
});

test('the same query empty under one scope, rows under another, is a wrong-scope trap (R3)', () => {
  // Identical arg KEYS, only the scope value (org) differs — the superset signal
  // (more keys) misses this; the wrong-scope signal must catch it.
  const turns = parseTranscript(
    jsonl([
      asst(call('w1', 'mcp__sf__query_records', { object: 'Case', org: 'sandbox' })),
      user(result('w1', '{"records":[]}')),
      asst(call('w2', 'mcp__sf__query_records', { object: 'Case', org: 'prod' })),
      user(result('w2', '{"records":[1,2,3]}')),
    ]),
  );
  const c = detectCandidates(turns);
  assert.equal(c.length, 1, 'the wrong-org trap is caught with identical keys and no prose');
  assert.match(c[0].reasons.join(' '), /wrong-scope/);
});

test('a nested empty array in a non-empty payload is not read as empty (R4)', () => {
  // Each row carries "labels":[]; the payload is NOT empty. The old looksEmpty
  // matched ":[]" anywhere and both mis-scored this and poisoned the superset.
  const turns = parseTranscript(
    jsonl([
      asst(call('n1', 'mcp__gh__list_issues', { repo: 'x' })),
      user(result('n1', '{"items":[{"id":1,"labels":[]},{"id":2,"labels":[]}]}')),
      asst(say('Actually it turns out this silently returns closed issues too, unexpectedly.')),
    ]),
  );
  // notable requires empty/error/expectation; this payload is NOT empty and there
  // was no stated expectation and no error, so the free-floating "actually" does
  // NOT clear the gate — which is correct (narration, not a tool-model change).
  assert.deepEqual(detectCandidates(turns), [], 'a non-empty payload with nested [] is not "notable" on prose alone');
});

test('genuinely empty shapes beyond {records:[]} are recognised (R4)', () => {
  for (const body of ['[]', '{"data":null}', '{"total_count":0}', '{"items":[]}', 'No results found']) {
    const turns = parseTranscript(
      jsonl([
        asst(call('g1', 'mcp__x__search', { q: 'a' })),
        user(result('g1', body)),
        asst(call('g2', 'mcp__x__search', { q: 'a', includeArchived: true })),
        user(result('g2', '{"items":[1,2]}')),
      ]),
    );
    const c = detectCandidates(turns);
    assert.equal(c.length, 1, `"${body}" must read as empty so the superset fires`);
  }
});

test('the agent\'s own built-in tools are not harvested (a Read is not a trap)', () => {
  // A Read of a file containing "[]" reads as empty; a later Read of the same
  // file with an offset is a structural superset. Before the built-in filter
  // this was the single biggest source of false candidates on a coding session.
  const turns = parseTranscript(
    jsonl([
      asst(call('r1', 'Read', { file_path: '/x.ts' })),
      user(result('r1', 'const empty = [];')),
      asst(call('r2', 'Read', { file_path: '/x.ts', offset: 40, limit: 20 })),
      user(result('r2', 'line 40\nline 41\nline 42')),
    ]),
  );
  assert.deepEqual(detectCandidates(turns), [], 'Read/Edit/Glob/Agent are the agent\'s hands, never an external trap');
});

test('an mcp__* tool with the same shape IS still harvested (gold is not dropped)', () => {
  // The recall guard: the built-in filter must not swallow the real target.
  // Identical structural trap to the Read case above, on an external MCP tool.
  const turns = parseTranscript(
    jsonl([
      asst(call('m1', 'mcp__sf__query_records', { object: 'Case' })),
      user(result('m1', '{"records":[]}')),
      asst(call('m2', 'mcp__sf__query_records', { object: 'Case', org: 'prod' })),
      user(result('m2', '{"records":[1,2,3]}')),
    ]),
  );
  const c = detectCandidates(turns);
  assert.equal(c.length, 1, 'an external MCP tool with a silent-scope trap is still caught');
  assert.equal(c[0].tool, 'mcp__sf__query_records');
});

test('a call the harness denied or the user cancelled is not a trap', () => {
  const turns = parseTranscript(
    jsonl([
      asst(say('I expect this to deploy.'), call('d1', 'mcp__sf__deploy', { path: 'force-app' })),
      user(result('d1', 'The user doesn\'t want to proceed with this tool use. The tool use was rejected.', true)),
      asst(say('Actually the deploy was blocked — turns out it needed approval.')),
    ]),
  );
  assert.deepEqual(detectCandidates(turns), [], 'a harness/permission denial never reached the tool, so it is not the tool\'s behaviour');
});

test('a genuine shell permission-denied still harvests (not confused with a harness denial)', () => {
  const turns = parseTranscript(
    jsonl([
      asst(say('I expect to read the file.'), call('s1', 'Bash', { command: 'cat /etc/shadow' })),
      user(result('s1', 'cat: /etc/shadow: Permission denied', true)),
      asst(say('Permission denied — actually it turns out this needs root, silently no output otherwise.')),
    ]),
  );
  const c = detectCandidates(turns);
  assert.equal(c.length, 1, 'a real shell permission trap is scoped away from the Claude Code permission phrasing and still harvests');
});
