/**
 * Auto-seal is the "you don't write anything" step: this machine's own findings
 * sign themselves under its key and land in the corpus's git history, with nobody
 * running sign or commit. The properties that matter: it signs only observations
 * authored under this machine's label, it commits locally (never pushes), and it
 * no-ops cleanly when there's nothing to do. Run via a subprocess so the key store
 * is read fresh, exactly as a real run would.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const REPO = process.cwd();
const KEYGEN = path.join(REPO, 'scripts', 'keygen.ts');
const SEAL = path.join(REPO, 'scripts', 'seal.ts');

function tsx(script: string, args: string[], home: string): string {
  return execFileSync('npx', ['tsx', script, ...args], { env: { ...process.env, CAIRN_HOME: home }, encoding: 'utf8' });
}
function git(home: string, args: string[]): string {
  return execFileSync('git', ['-C', home, ...args], { encoding: 'utf8' });
}

function finding(by: string): object {
  return {
    id: 'cairn-9001',
    title: 'a probe finding for the seal test',
    claim: 'This is a falsifiable probe claim used only to exercise the seal path end to end.',
    kind: 'trap',
    subject: { name: 'seal-test', ecosystem: 'test', versions: '*' },
    scope: 'environment-specific',
    appliesTo: 'the seal test only',
    tags: [],
    cost: 'minutes',
    expectation: 'nothing happens',
    reality: 'something happens',
    evidence: [{ command: 'true', output: '' }],
    check: { command: 'true', confirmedIf: 'exit 0', refutedIf: 'exit 1', manual: false },
    provenance: 'firsthand',
    halfLifeDays: 365,
    observations: [{ at: '2026-09-03T00:00:00.000Z', by, verdict: 'confirmed', note: 'seen', environment: { os: 'linux' } }],
    status: 'active',
    createdAt: '2026-09-03T00:00:00.000Z',
    triggers: [],
    visibility: 'shared',
  };
}

function world(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-seal-'));
  fs.mkdirSync(path.join(home, 'cairn'), { recursive: true });
  return home;
}

/** What a TRUSTED write path (the operator's CLI) records: this observation is ours to sign. */
function journal(home: string, findingId: string, at: string): void {
  const dir = path.join(home, '.cairn-secrets');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'pending-signatures.jsonl'), JSON.stringify({ f: findingId, at }) + '\n');
}

test('a JOURNALLED observation under the machine label signs itself and commits', () => {
  const home = world();
  tsx(KEYGEN, ['joey.ahern'], home); // this machine's identity
  fs.writeFileSync(path.join(home, 'cairn', '9001.json'), JSON.stringify(finding('joey.ahern'), null, 2));
  journal(home, 'cairn-9001', '2026-09-03T00:00:00.000Z'); // a trusted path marked it
  git(home, ['init', '-q']);
  git(home, ['config', 'user.email', 'test@example.com']);
  git(home, ['config', 'user.name', 'test']);

  const out = tsx(SEAL, [], home);
  assert.match(out, /signed 1 observation/, 'it signed the one observation');
  assert.match(out, /committed/, 'and committed');

  const sealed = JSON.parse(fs.readFileSync(path.join(home, 'cairn', '9001.json'), 'utf8'));
  const sig = sealed.observations[0].signature;
  assert.ok(sig, 'the observation now carries a signature');
  assert.equal(sig.algorithm, 'ed25519');
  assert.match(sig.keyId, /^[0-9a-f]{16}$/, 'signed by this machine key');
  assert.match(git(home, ['log', '--oneline']), /sign and record|cairn/, 'a commit landed in the corpus git history');
});

test('a by-label observation that was NOT journalled is refused (no signing oracle)', () => {
  /* The attack: a model plants `by: "joey.ahern"` on an unsigned observation.
   * It matches the machine label, but no trusted path journalled it, so autoseal
   * must NOT sign it — else the operator's key certifies a fabricated claim. */
  const home = world();
  tsx(KEYGEN, ['joey.ahern'], home);
  fs.writeFileSync(path.join(home, 'cairn', '9001.json'), JSON.stringify(finding('joey.ahern'), null, 2));
  // deliberately NOT journalled
  const out = tsx(SEAL, [], home);
  assert.match(out, /signed 0 observation/, 'an un-journalled by-label observation is never auto-signed');
  const after = JSON.parse(fs.readFileSync(path.join(home, 'cairn', '9001.json'), 'utf8'));
  assert.ok(!after.observations[0].signature, 'stays unsigned — attributable to nobody');
});

test('it does not sign an observation authored by someone else', () => {
  const home = world();
  tsx(KEYGEN, ['joey.ahern'], home);
  fs.writeFileSync(path.join(home, 'cairn', '9001.json'), JSON.stringify(finding('someone-else'), null, 2));

  const out = tsx(SEAL, [], home);
  assert.match(out, /signed 0 observation/, "a different author's observation is left for their own key");
  const after = JSON.parse(fs.readFileSync(path.join(home, 'cairn', '9001.json'), 'utf8'));
  assert.ok(!after.observations[0].signature, 'still unsigned');
});

test('with no identity on the machine, seal no-ops cleanly', () => {
  const home = world();
  fs.writeFileSync(path.join(home, 'cairn', '9001.json'), JSON.stringify(finding('joey.ahern'), null, 2));
  const out = tsx(SEAL, [], home);
  assert.match(out, /no signing identity/, 'nothing signed, said so, exit 0');
});
