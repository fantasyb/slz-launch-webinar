import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expiredCairnContainers } from '../scripts/container-reaper.mjs';

test('independent reaper selects only expired Cairn identities, never unlabelled or live containers', () => {
  const now = 1800000000000;
  const c = { Id: 'a'.repeat(64), Name: '/cairn-11111111-1111-4111-8111-111111111111', Config: { Labels: { 'cairn.isolated': 'true', 'cairn.expires': String(now - 1) } } };
  const candidates = [c,
    { ...c, Id: '--privileged' }, { ...c, Name: '/another-service' },
    { ...c, Config: { Labels: { 'cairn.isolated': 'false', 'cairn.expires': String(now - 1) } } },
    { ...c, Config: { Labels: { 'cairn.isolated': 'true', 'cairn.expires': String(now + 1) } } },
    { ...c, Config: { Labels: { 'cairn.isolated': 'true', 'cairn.expires': 'invalid' } } },
    { ...c, Config: {} },
  ];
  assert.deepEqual(expiredCairnContainers(candidates, now), [c]);
});
