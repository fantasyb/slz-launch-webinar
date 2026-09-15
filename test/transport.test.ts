/**
 * The panel transport, which had never executed once.
 *
 * A wrong field path in a provider's response shape yields empty text rather
 * than an error, and empty text is indistinguishable from a model that
 * declined to answer. These pin each provider's request and response shapes
 * against a recorded example, so a shape change fails here rather than
 * silently removing a panellist from every run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCall, parseForecast, MAX_RESPONSE_BYTES } from '../src/lib/cairn/panel';
import type { PanelMember } from '../src/lib/cairn/panel';

const member = (provider: string, model = 'm'): PanelMember =>
  ({ label: 'x', provider, model, apiKeyEnv: 'K' }) as PanelMember;

test('anthropic: text is read from the content blocks', () => {
  const call = buildCall(member('anthropic'), 'key', 'prompt', 16000, 'sys');
  assert.equal(call.headers['x-api-key'], 'key');
  assert.equal((call.body as { max_tokens: number }).max_tokens, 16000);
  const reply = {
    content: [
      { type: 'thinking', thinking: 'reasoning that must not be returned' },
      { type: 'text', text: '{"priorConfirmed":0.7}' },
    ],
  };
  assert.equal(call.extract(reply), '{"priorConfirmed":0.7}');
});

test('openai sends max_completion_tokens; xai sends max_tokens', () => {
  const openai = buildCall(member('openai'), 'k', 'p', 16000, 's').body as Record<string, unknown>;
  const xai = buildCall(member('xai'), 'k', 'p', 16000, 's').body as Record<string, unknown>;
  assert.equal(openai.max_completion_tokens, 16000);
  assert.equal(openai.max_tokens, undefined);
  assert.equal(xai.max_tokens, 16000);
  assert.equal(xai.max_completion_tokens, undefined);
});

test('openai/xai: text is read from choices[0].message.content', () => {
  const call = buildCall(member('openai'), 'k', 'p', 16000, 's');
  assert.equal(call.extract({ choices: [{ message: { content: 'hello' } }] }), 'hello');
  assert.equal(call.extract({ choices: [] }), '');
});

test('google: the key is a header, never the URL', () => {
  const call = buildCall(member('google', 'gemini-x'), 'SECRET', 'p', 16000, 's');
  assert.ok(!call.url.includes('SECRET'), `key leaked into the URL: ${call.url}`);
  assert.equal(call.headers['x-goog-api-key'], 'SECRET');
  assert.equal(
    call.extract({ candidates: [{ content: { parts: [{ text: 'a' }, { text: 'b' }] } }] }),
    'ab',
  );
});

test('a reply that mentions fenced JSON is not rewritten', () => {
  // The fence strip ran over the whole reply including inside string values,
  // so this reasoning was silently altered and then hashed into the seal.
  const raw = JSON.stringify({
    priorConfirmed: 0.5,
    reasoning: 'the fix is to wrap output in ```json fences',
  });
  assert.equal(parseForecast(raw).reasoning, 'the fix is to wrap output in ```json fences');
});

test('fenced and prose-wrapped replies still parse', () => {
  const inner = '{"priorConfirmed":0.25,"reasoning":"because the proxy allowlists hosts"}';
  assert.equal(parseForecast('```json\n' + inner + '\n```').priorConfirmed, 0.25);
  assert.equal(parseForecast('Here is my forecast:\n' + inner).priorConfirmed, 0.25);
});

test('unparseable replies are errors, not defaults', () => {
  for (const bad of ['', 'no json here', '{"priorConfirmed":', '{"priorConfirmed":2}']) {
    assert.throws(() => parseForecast(bad), `should have thrown on: ${JSON.stringify(bad)}`);
  }
});

test('the response size bound is set', () => {
  assert.ok(MAX_RESPONSE_BYTES > 0 && MAX_RESPONSE_BYTES <= 32 * 1024 * 1024);
});
