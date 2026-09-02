/**
 * The proxy annotates a result and never withholds one.
 *
 * Push delivery is the binding constraint — cairn-0035 measured that an agent
 * which does not ask gets nothing — and the two obvious channels each solve
 * half of it. MCP tools are PULL, something the agent must decide to call. A
 * client hook is real push and belongs to one vendor. A tool RESULT is the
 * one piece of text an agent reads in every client with no feature to
 * negotiate, so the finding travels on the result it is about.
 *
 * Driven over real stdio against a real upstream server rather than by
 * calling the annotate function, because the thing that has failed twice
 * today is exactly the gap between "the function returns the right string"
 * and "the model receives it".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const REPO = process.cwd();

/** A corpus holding one finding about one of the fixture server's tools. */
function corpusWithToolFinding(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-proxy-'));
  fs.mkdirSync(path.join(home, 'cairn'));
  const donor = JSON.parse(
    fs.readFileSync(path.join(REPO, 'cairn', fs.readdirSync(path.join(REPO, 'cairn'))[0]), 'utf8'),
  );
  fs.writeFileSync(
    path.join(home, 'cairn', '0001-tool.json'),
    JSON.stringify({
      ...donor,
      id: 'cairn-0001',
      title: 'the query tool returns empty rather than erroring on a stale mapping',
      reality: 'the call succeeds and returns zero rows',
      workaround: 'check the mapping timestamp before trusting a zero-row result',
      triggers: ['mcp__data360__query_records'],
      visibility: 'private',
      observations: [{ by: 't', at: '2026-09-01T00:00:00.000Z', verdict: 'confirmed', note: 'seen here' }],
    }),
  );
  return home;
}

function speak(home: string, requests: string[]): Record<string, unknown>[] {
  const file = path.join(home, 'req.jsonl');
  fs.writeFileSync(file, `${requests.join('\n')}\n`);
  const out = path.join(home, 'out.jsonl');
  try {
    execFileSync(
      'bash',
      ['-c', `timeout 25 npx tsx scripts/mcp-proxy.ts --server "node fixtures/mcp/upstream.mjs" < ${file} > ${out} 2>/dev/null`],
      { cwd: REPO, env: { ...process.env, CAIRN_HOME: home } },
    );
  } catch {
    /* The server does not exit on stdin close; the timeout is how it ends. */
  }
  return fs
    .readFileSync(out, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const INIT =
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}';

test('a finding rides back on the result of the tool it is about', () => {
  const home = corpusWithToolFinding();
  const msgs = speak(home, [
    INIT,
    '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"mcp__data360__query_records","arguments":{"object":"Account"}}}',
  ]);

  const init = msgs.find((m) => m.id === 1) as { result?: { instructions?: string } };
  assert.ok(init?.result?.instructions, 'instructions at connect are the floor for clients with no hooks');

  const call = msgs.find((m) => m.id === 2) as { result?: { content: { text: string }[] } };
  const texts = (call?.result?.content ?? []).map((c) => c.text);
  assert.ok(texts.some((t) => t.includes('"records":[]')), 'the tool\'s own result must be returned intact');
  const note = texts.find((t) => t.includes('cairn-0001'));
  assert.ok(note, 'the finding must reach the model on the result');
  // Load-bearing rather than decorative: this appends to text a model
  // implicitly trusts, so the sender has to be unmistakable.
  assert.match(note, /not from this tool/);
});

test('a tool nothing is recorded about comes back untouched', () => {
  const home = corpusWithToolFinding();
  const msgs = speak(home, [
    INIT,
    '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"mcp__data360__unrelated","arguments":{}}}',
  ]);
  const call = msgs.find((m) => m.id === 2) as { result?: { content: { text: string }[] } };
  assert.deepEqual(call?.result?.content, [{ type: 'text', text: 'ok' }]);
});

test('an empty corpus never blocks or alters a call', () => {
  // Never a gate. A mechanism that can withhold a result is one people switch
  // off, and then it delivers nothing at all.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-proxy-empty-'));
  fs.mkdirSync(path.join(home, 'cairn'));
  const msgs = speak(home, [
    INIT,
    '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"mcp__data360__query_records","arguments":{"object":"Account"}}}',
  ]);
  const call = msgs.find((m) => m.id === 2) as { result?: { content: { text: string }[] } };
  assert.deepEqual(call?.result?.content, [{ type: 'text', text: '{"status":"success","records":[]}' }]);
});
