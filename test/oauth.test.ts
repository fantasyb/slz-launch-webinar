import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalOAuthProvider, oauthFile, oauthUrl, readOAuth, recordConnectionCheck } from '../src/lib/cairn/oauth';
import { anonymousCoverage, connect, coverage, discover, readManifest } from '../src/lib/cairn/setup';

const value = ['fixture', 'value'].join('-');
function fixture(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-oauth-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = oauthFile(path.join(dir, 'setup'), 'a'.repeat(24));
  return { dir, file, url: 'https://example.test/mcp' };
}
test('OAuth storage is private, URL-bound, and rejects linked or readable credentials', async (t) => {
  const { dir, file, url } = fixture(t);
  const p = new LocalOAuthProvider(file, url);
  p.saveTokens({ access_token: value, token_type: 'Bearer', expires_in: 3600 });
  assert.equal((await p.tokens())?.access_token, value);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.throws(() => readOAuth(file, url + '/other'), /another connection/);
  fs.chmodSync(file, 0o644); assert.throws(() => readOAuth(file, url), /unreadable/);
  fs.chmodSync(file, 0o600);
  const link = path.join(dir, 'link.json'); fs.symlinkSync(file, link);
  assert.throws(() => readOAuth(link, url), /unreadable/);
  for (const u of ['http://example.test/mcp', 'https://user:password@example.test/mcp', 'file:///tmp/token', url + '#fragment']) assert.throws(() => oauthUrl(u));
  assert.equal(oauthUrl('http://127.0.0.1:1234/mcp').protocol, 'http:');
});
test('runtime never opens login and stale processes cannot invalidate newly refreshed credentials', async (t) => {
  const { file, url } = fixture(t), p = new LocalOAuthProvider(file, url);
  assert.throws(() => p.clientInformation(), /Sign-in required/);
  assert.equal(readOAuth(file, url).needsLogin, true);
  await assert.rejects(p.redirectToAuthorization(new URL(url)), /Sign-in required/);
  p.saveTokens({ access_token: value, token_type: 'Bearer' }); await p.tokens();
  const next = new LocalOAuthProvider(file, url);
  next.saveTokens({ access_token: value + '-rotated', token_type: 'Bearer' });
  p.invalidateCredentials('tokens');
  assert.equal(readOAuth(file, url).tokens?.access_token, value + '-rotated');
});
test('expired credentials refresh once across concurrent providers, retaining omitted refresh tokens', async (t) => {
  const { file, url } = fixture(t);
  const p = new LocalOAuthProvider(file, url, { redirectUrl: 'http://127.0.0.1:1234/callback', open: async () => { throw new Error('must not open'); } });
  p.saveClientInformation({ client_id: 'fixture-client' });
  p.saveDiscoveryState({ authorizationServerUrl: 'https://example.test', resourceMetadata: { resource: url }, authorizationServerMetadata: {
    issuer: 'https://example.test', authorization_endpoint: 'https://example.test/authorize', token_endpoint: 'https://example.test/token', response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'],
  } });
  p.saveTokens({ access_token: value, refresh_token: value, token_type: 'Bearer', expires_in: -1 });
  let calls = 0;
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://example.test/token');
    assert.equal(new URLSearchParams(String(init?.body)).get('grant_type'), 'refresh_token');
    calls++; await new Promise((r) => setTimeout(r, 30));
    return Response.json({ access_token: value + '-new', token_type: 'Bearer', expires_in: 3600 });
  };
  const tokens = await Promise.all([p.tokens(), new LocalOAuthProvider(file, url).tokens()]);
  assert.equal(calls, 1); assert.ok(tokens.every((x) => x?.access_token === value + '-new' && x.refresh_token === value));
  assert.ok(!fs.existsSync(file + '.refresh.lock'));
});
test('connection check is required before config mutation and never counts as pilot traffic', (t) => {
  const { dir, url } = fixture(t);
  fs.mkdirSync(path.join(dir, '.cursor'));
  const config = path.join(dir, '.cursor/mcp.json');
  const original = JSON.stringify({ mcpServers: { remote: { url } } }); fs.writeFileSync(config, original);
  const d = discover({ userHome: dir, platform: 'linux' }), c = d.connections[0];
  const stateDir = path.join(dir, 'setup'), file = oauthFile(stateDir, c.id);
  const options = { root: process.cwd(), home: path.join(dir, 'corpus'), stateDir, projects: [], autowrite: true };
  assert.throws(() => connect([c], options), /Finish the connection check/);
  assert.equal(fs.readFileSync(config, 'utf8'), original);
  assert.equal(readManifest(stateDir).connections.length, 0);
  recordConnectionCheck(file, url, 3);
  assert.equal(connect([c], options), 1);
  const m = readManifest(stateDir), report = coverage(discover({ userHome: dir, platform: 'linux', manifest: m }), m, []);
  assert.equal(report.connections[0].verified, false);
  assert.equal(report.connections[0].attempts, 0);
  new LocalOAuthProvider(file, url).saveTokens({ access_token: value, token_type: 'Bearer' });
  assert.ok(!JSON.stringify(m).includes(value)); assert.ok(!JSON.stringify(anonymousCoverage(report)).includes(value));
});
