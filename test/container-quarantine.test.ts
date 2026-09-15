import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ContainerQuarantine, workloadId } from '../src/lib/cairn/container-quarantine';

const identity = { image: `sha256:${'a'.repeat(64)}`, command: '/node', args: ['/tool.mjs'] };
test('quarantine survives store reconstruction and does not deny an unrelated workload', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-quarantine-'));
  try {
    const id = workloadId(identity);
    const store = new ContainerQuarantine(directory);
    store.assertAdmitted(id);
    store.record(id);
    store.record(id); // repeat reports do not replace evidence
    assert.throws(() => new ContainerQuarantine(directory).assertAdmitted(id), /quarantined/);
    store.assertAdmitted(workloadId({ ...identity, args: ['/another-tool.mjs'] }));
    const file = path.join(directory, `${id}.json`);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).reason, 'transport-fault');
    fs.writeFileSync(file, '');
    assert.throws(() => store.assertAdmitted(id), /quarantined/, 'corrupt evidence cannot grant admission');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('an unreadable store fails closed and identities cannot escape its directory', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-quarantine-'));
  try {
    const file = path.join(directory, 'not-a-directory');
    fs.writeFileSync(file, '');
    assert.throws(() => new ContainerQuarantine(file).assertAdmitted(workloadId(identity)), /Cannot verify/);
    assert.throws(() => new ContainerQuarantine(directory).record('../escape'), /Invalid workload/);
    assert.throws(() => new ContainerQuarantine(directory).assertAdmitted('../escape'), /Cannot verify/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('workload identity separates executable, arguments, and image without delimiter ambiguity', () => {
  assert.notEqual(workloadId(identity), workloadId({ ...identity, image: `sha256:${'b'.repeat(64)}` }));
  assert.notEqual(workloadId(identity), workloadId({ ...identity, command: '/other' }));
  assert.notEqual(workloadId({ ...identity, args: ['a', 'b'] }), workloadId({ ...identity, args: ['a,b'] }));
});
