import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import { pinPath } from '../src/lib/cairn/trust';
import { authorize, tokenHash, readAudit, type OrgPolicy } from '../src/lib/cairn/enterprise';
import { baseHome, startProxy, startProxyExpectingExit, stopProxy, closeOpenReqs, openSession, rpc, rpcResult, FIXTURE } from './helpers/hosted';

test('strict read-only is never more permissive than read-only across annotation combinations', () => {
  const principal = { id: 'viewer', role: 'viewer' };
  for (const name of ['get_records', 'delete_records', 'sf__get_records']) {
    for (const readOnlyHint of [undefined, false, true]) {
      for (const destructiveHint of [undefined, false, true]) {
        for (const readTools of [undefined, [name]]) {
          const policy = (strict: boolean): OrgPolicy => ({
            auth: { required: true }, principals: {},
            roles: { viewer: { ...(strict ? { readOnlyStrict: true } : { readOnly: true }), readTools } },
          });
          const tool = { name, annotations: { readOnlyHint, destructiveHint } };
          const loose = authorize(policy(false), principal, 'sf', tool);
          const strict = authorize(policy(true), principal, 'sf', tool);
          assert.ok(!strict.allowed || loose.allowed, JSON.stringify({ tool, readTools, strict, loose }));
          if (destructiveHint === true || readOnlyHint === false) {
            assert.equal(strict.allowed, false, 'a positive write declaration cannot be overruled');
          }
        }
      }
    }
  }
});

test('a conflicting read-only/destructive tool cannot execute for a strict tenant', async () => {
  const home = baseHome('cairn-adversarial-annotations-');
  const marker = path.join(home, 'upstream-called');
  const viewerToken = ['fixture', 'strict', 'viewer'].join('-');
  const adminToken = ['fixture', 'strict', 'admin'].join('-');
  fs.writeFileSync(path.join(home, 'org-policy.json'), JSON.stringify({
    auth: { required: true },
    principals: {
      [tokenHash(viewerToken)]: { id: 'viewer', role: 'viewer' },
      [tokenHash(adminToken)]: { id: 'admin', role: 'admin' },
    },
    roles: { viewer: { readOnlyStrict: true, readTools: ['get_records'] }, admin: {} },
  }));
  const { child, base } = await startProxy(home, {}, ['--server', `node ${FIXTURE} --conflicting-read-marker ${marker}`]);
  try {
    const viewer = await openSession(base, viewerToken);
    assert.equal(viewer.status, 200);
    const denied = await rpc(base, viewerToken, viewer.sid, 2, 'tools/call', { name: 'get_records', arguments: {} });
    assert.equal(fs.existsSync(marker), false, 'the forbidden operation never reached the upstream');
    assert.equal(rpcResult(denied.body)?.isError, true, denied.body);
    const listing = await rpc(base, viewerToken, viewer.sid, 3, 'tools/list', {});
    assert.doesNotMatch(listing.body, /"name":"get_records"/);
    assert.ok(readAudit(path.join(home, 'audit')).some((row) => row.principal === 'viewer' && row.decision === 'deny' && row.tool === 'get_records'));

    // Positive control: the fixture is live and the admin role can execute it.
    const admin = await openSession(base, adminToken);
    assert.equal(admin.status, 200);
    const allowed = await rpc(base, adminToken, admin.sid, 4, 'tools/call', { name: 'get_records', arguments: {} });
    assert.match(allowed.body, /operation performed/);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'called');
  } finally {
    closeOpenReqs();
    stopProxy(child);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

for (const mode of ['rbac', 'trust'] as const) {
  test(`reconnected upstream must be re-evaluated before a cached tool call (${mode})`, async () => {
    const home = baseHome(`cairn-adversarial-reconnect-${mode}-`);
    const marker = path.join(home, 'restarted');
    const token = ['fixture', 'reconnect', mode].join('-');
    fs.writeFileSync(path.join(home, 'org-policy.json'), JSON.stringify({
      auth: { required: true },
      principals: { [tokenHash(token)]: { id: 'caller', role: 'caller' } },
      roles: { caller: mode === 'rbac' ? { readOnlyStrict: true } : {} },
    }));
    const { child, base } = await startProxy(home, { CAIRN_TRUST_MODE: mode === 'trust' ? 'enforce' : 'off' },
      ['--server', `node ${FIXTURE} --restart-read-marker ${marker}`]);
    try {
      const session = await openSession(base, token);
      assert.equal(session.status, 200);
      const first = await rpc(base, token, session.sid, 2, 'tools/call', { name: 'get_records', arguments: {} });
      assert.equal(rpcResult(first.body)?.isError, true, 'the initially approved upstream deliberately disconnects');
      assert.equal(fs.existsSync(marker), true, 'the first call reached the approved upstream');
      // No intervening tools/list: use the cached name after the process restarts.
      const second = await rpc(base, token, session.sid, 3, 'tools/call', { name: 'get_records', arguments: {} }, { settleMs: 6000 });
      assert.equal(fs.existsSync(`${marker}.executed`), false, `${mode}: changed operation must not execute under cached approval`);
      assert.equal(rpcResult(second.body)?.isError, true, second.body);
      assert.match(second.body, mode === 'rbac' ? /not permitted/ : /withheld/);
    } finally {
      closeOpenReqs();
      stopProxy(child);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}

test('trust enforcement fails closed when the approval pin cannot be persisted', async () => {
  const home = baseHome('cairn-adversarial-pin-');
  const marker = path.join(home, 'upstream-called');
  // A file where the directory belongs deterministically prevents pin writes,
  // even when this test runs as root (chmod would not prove that).
  fs.writeFileSync(path.join(home, 'trust'), 'not a directory');
  const { child, base } = await startProxy(home, { CAIRN_TRUST_MODE: 'enforce' },
    ['--server', `node ${FIXTURE} --conflicting-read-marker ${marker}`]);
  try {
    const session = await openSession(base, undefined);
    assert.equal(session.status, 200);
    const result = await rpc(base, undefined, session.sid, 2, 'tools/call', { name: 'get_records', arguments: {} });
    assert.equal(fs.existsSync(marker), false, 'enforce must not execute an operation whose approval could not be stored');
    assert.equal(rpcResult(result.body)?.isError, true, result.body);
    const prompt = await rpc(base, undefined, session.sid, 3, 'prompts/get', { name: 'greet', arguments: {} });
    assert.doesNotMatch(prompt.body, /prompt body text from upstream/);
    assert.match(prompt.body, /withheld/);
  } finally {
    closeOpenReqs();
    stopProxy(child);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

for (const damage of ['invalid-json', 'invalid-prompts', 'removed'] as const) {
  test(`damaged approval is never silently replaced or bypassed (${damage})`, async () => {
    const home = baseHome('cairn-damaged-approval-');
    const marker = path.join(home, 'upstream-called');
    const { child, base } = await startProxy(home, { CAIRN_TRUST_MODE: 'enforce' },
      ['--server', `node ${FIXTURE} --conflicting-read-marker ${marker}`]);
    try {
      const session = await openSession(base, undefined);
      assert.equal(session.status, 200);
      // Prime routing while the original pin is valid, then damage it. A direct
      // call must recheck approval even though it need not refresh the tool list.
      await rpc(base, undefined, session.sid, 2, 'tools/list', {});
      await rpc(base, undefined, session.sid, 20, 'prompts/list', {});
      const pins = fs.readdirSync(path.join(home, 'trust')).filter((f) => f.endsWith('.json'));
      assert.equal(pins.length, 1);
      const file = path.join(home, 'trust', pins[0]);
      const original = fs.readFileSync(file, 'utf8');
      const bad = damage === 'invalid-json' ? '{broken' : JSON.stringify({ ...JSON.parse(original), prompts: 'corrupt' });
      if (damage === 'removed') fs.unlinkSync(file);
      else fs.writeFileSync(file, bad);
      const call = await rpc(base, undefined, session.sid, 3, 'tools/call', { name: 'get_records', arguments: {} });
      assert.equal(fs.existsSync(marker), false, 'cached approval must not survive damaged/missing storage');
      assert.equal(rpcResult(call.body)?.isError, true, call.body);
      const prompt = await rpc(base, undefined, session.sid, 21, 'prompts/get', { name: 'greet', arguments: {} });
      assert.match(prompt.body, /withheld/);
      assert.doesNotMatch(prompt.body, /prompt body text from upstream/);
      await rpc(base, undefined, session.sid, 4, 'tools/list', {});
      if (damage === 'removed') assert.equal(fs.existsSync(file), false, 'deletion is not implicit reapproval while running');
      else assert.equal(fs.readFileSync(file, 'utf8'), bad, 'damaged evidence is preserved for the operator');
      // Repairing the exact approval restores service without weakening policy.
      fs.writeFileSync(file, original);
      await rpc(base, undefined, session.sid, 5, 'tools/list', {});
      const restored = await rpc(base, undefined, session.sid, 6, 'tools/call', { name: 'get_records', arguments: {} });
      assert.match(restored.body, /operation performed/);
      assert.equal(fs.readFileSync(marker, 'utf8'), 'called');
    } finally {
      closeOpenReqs();
      stopProxy(child);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}

test('explicit approval mode never bootstraps an unknown upstream', async () => {
  const home = baseHome('cairn-explicit-approval-');
  const marker = path.join(home, 'upstream-called');
  const { child, base } = await startProxy(home, { CAIRN_TRUST_MODE: 'enforce', CAIRN_TRUST_BOOTSTRAP: 'explicit' },
    ['--server', `service=node ${FIXTURE} --conflicting-read-marker ${marker}`]);
  try {
    const session = await openSession(base, undefined);
    const result = await rpc(base, undefined, session.sid, 2, 'tools/call', { name: 'get_records', arguments: {} });
    assert.equal(fs.existsSync(marker), false, 'first connection must not create its own authority');
    assert.equal(rpcResult(result.body)?.isError, true, result.body);
    assert.equal(fs.existsSync(path.join(home, 'trust')), false, 'explicit mode must not create approvals');
  } finally {
    closeOpenReqs();
    stopProxy(child);
    fs.rmSync(home, { recursive: true, force: true });
  }
});


test('explicit approval requires reviewed imports, covers each channel, and survives restart deletion', async () => {
  const staging = baseHome('cairn-approval-capture-');
  const home = baseHome('cairn-approval-production-');
  const marker = path.join(home, 'upstream-called');
  const args = ['--server', `service=node ${FIXTURE} --conflicting-read-marker ${marker}`];
  const env = { CAIRN_TRUST_MODE: 'enforce', CAIRN_TRUST_BOOTSTRAP: 'explicit' };
  let running: Awaited<ReturnType<typeof startProxy>> | undefined;
  try {
    // Disposable enrollment fixture: listing only, never tools/call.
    running = await startProxy(staging, { CAIRN_TRUST_MODE: 'monitor', CAIRN_TRUST_BOOTSTRAP: 'tofu' }, args);
    const enrollment = await openSession(running.base, undefined);
    await rpc(running.base, undefined, enrollment.sid, 2, 'tools/list', {});
    await rpc(running.base, undefined, enrollment.sid, 3, 'prompts/list', {});
    const candidate = JSON.parse(fs.readFileSync(pinPath('service', path.join(staging, 'trust')), 'utf8'));
    assert.ok(candidate.prompts.length > 0);
    assert.equal(fs.existsSync(marker), false);
    closeOpenReqs(); stopProxy(running.child); running = undefined;

    const file = path.join(staging, 'reviewed.json');
    const approve = (raw: string) => {
      fs.writeFileSync(file, raw);
      const digest = createHash('sha256').update(raw).digest('hex');
      const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/trust.ts', '--approve-file', file, '--server', 'service', '--sha256', digest],
        { env: { ...process.env, ...env, CAIRN_HOME: home }, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    };
    const toolsOnly = { ...candidate }; delete toolsOnly.prompts;
    approve(JSON.stringify(toolsOnly));
    const pinFile = pinPath('service', path.join(home, 'trust'));
    const original = fs.readFileSync(pinFile, 'utf8');
    running = await startProxy(home, env, args);
    let session = await openSession(running.base, undefined);
    const permitted = await rpc(running.base, undefined, session.sid, 2, 'tools/call', { name: 'get_records', arguments: {} });
    assert.match(permitted.body, /operation performed/);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'called');
    const prompt = await rpc(running.base, undefined, session.sid, 3, 'prompts/get', { name: 'greet', arguments: {} });
    assert.match(prompt.body, /withheld/);
    assert.doesNotMatch(prompt.body, /prompt body text from upstream/);
    assert.equal(fs.readFileSync(pinFile, 'utf8'), original, 'production cannot auto-approve the missing prompt channel');

    approve(JSON.stringify(candidate));
    await rpc(running.base, undefined, session.sid, 4, 'prompts/list', {});
    const approvedPrompt = await rpc(running.base, undefined, session.sid, 5, 'prompts/get', { name: 'greet', arguments: {} });
    assert.match(approvedPrompt.body, /prompt body text from upstream/);
    const roster = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/trust.ts'],
      { env: { ...process.env, ...env, CAIRN_HOME: home }, encoding: 'utf8' });
    assert.equal(roster.status, 0, roster.stderr);
    assert.match(roster.stdout, /service\s+\d+ tool/);
    assert.doesNotMatch(roster.stdout, /unreadable pin/);
    const deletion = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/trust.ts', '--reapprove', 'service'],
      { env: { ...process.env, ...env, CAIRN_HOME: home }, encoding: 'utf8' });
    assert.equal(deletion.status, 2, 'legacy deletion workflow is refused in explicit mode');
    assert.ok(fs.existsSync(pinFile));

    closeOpenReqs(); stopProxy(running.child); running = undefined;
    fs.unlinkSync(pinFile); fs.unlinkSync(marker);
    running = await startProxy(home, env, args);
    session = await openSession(running.base, undefined);
    const denied = await rpc(running.base, undefined, session.sid, 6, 'tools/call', { name: 'get_records', arguments: {} });
    assert.equal(rpcResult(denied.body)?.isError, true, denied.body);
    assert.equal(fs.existsSync(marker), false, 'restarting cannot restore lost approval');
    assert.equal(fs.existsSync(pinFile), false, 'production never recreates the deleted pin');
  } finally {
    closeOpenReqs();
    if (running) stopProxy(running.child);
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('unsafe or misspelled explicit bootstrap configuration refuses startup', async () => {
  const home = baseHome('cairn-bootstrap-config-');
  try {
    for (const env of [
      { CAIRN_TRUST_MODE: 'off', CAIRN_TRUST_BOOTSTRAP: 'explicit' },
      { CAIRN_TRUST_MODE: 'monitor', CAIRN_TRUST_BOOTSTRAP: 'explicit' },
      { CAIRN_TRUST_MODE: 'enforce', CAIRN_TRUST_BOOTSTRAP: 'explict' },
    ]) {
      const result = await startProxyExpectingExit(home, env);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /Explicit approval requires|CAIRN_TRUST_BOOTSTRAP must/);
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
