/**
 * Auto-mount: when you work in a repo that has its own .cairn corpus, its findings
 * appear ALONGSIDE the machine corpus, namespaced by the project's origin, with no
 * config — being in the repo is the whole trigger. The machine corpus stays primary
 * (writes and tool traps), so a project session never loses the everywhere-knowledge.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { projectCorpusHome, loadProjectCorpus } from '../src/lib/cairn/mount';

const REPO = process.cwd();
const TSX = path.join(REPO, 'node_modules', '.bin', 'tsx');

/* One fixed machine corpus for the whole file (cairnHome memoises, so it must not change). */
const MACHINE = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-machine-'));
fs.mkdirSync(path.join(MACHINE, 'cairn'), { recursive: true });
process.env.CAIRN_HOME = MACHINE;

function finding(id: string, title: string): object {
  return {
    id,
    title,
    claim: 'A falsifiable probe claim long enough to satisfy the minimum length rule for findings.',
    kind: 'trap',
    subject: { name: 'x', ecosystem: 'test', versions: '*' },
    scope: 'environment-specific',
    appliesTo: 'test',
    tags: [],
    cost: 'minutes',
    expectation: 'x',
    reality: 'y',
    evidence: [{ command: 'true', output: '' }],
    check: { command: 'true', confirmedIf: 'exit 0', refutedIf: 'exit 1', manual: false },
    provenance: 'firsthand',
    halfLifeDays: 365,
    observations: [{ at: '2026-09-03T00:00:00.000Z', by: 'joey.ahern', verdict: 'confirmed', environment: { os: 'linux' } }],
    status: 'active',
    createdAt: '2026-09-03T00:00:00.000Z',
    triggers: [],
    visibility: 'shared',
  };
}

/** A repo with a project corpus holding one finding under a given origin. */
function repoWithCorpus(origin: string, id: string): string {
  const repo = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-repo-')), 'app');
  const home = path.join(repo, '.cairn');
  fs.mkdirSync(path.join(home, 'cairn'), { recursive: true });
  fs.writeFileSync(path.join(home, 'cairn.config.json'), JSON.stringify({ origin, upstreams: [] }));
  fs.writeFileSync(path.join(home, 'cairn', `${id}.json`), JSON.stringify(finding(id, 'a project trap')));
  return repo;
}

test('projectCorpusHome finds a .cairn at or above the cwd', () => {
  const repo = repoWithCorpus('app-aa11bb', 'cairn-0001');
  const nested = path.join(repo, 'src', 'deep');
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(projectCorpusHome(nested), path.join(repo, '.cairn'), 'ascends to the repo corpus');
  assert.equal(projectCorpusHome(os.tmpdir()), null, 'and finds none where there is none');
});

test('the primary corpus is never mounted as its own project', () => {
  /* If cwd resolves the primary home itself, it must not double-mount. */
  const nested = path.dirname(MACHINE); // MACHINE has no .cairn parent, so null anyway
  assert.equal(projectCorpusHome(nested), null);
});

test('loadProjectCorpus reads the project findings and its origin', () => {
  const repo = repoWithCorpus('coolapp-9f3a2b', 'cairn-0001');
  const mounted = loadProjectCorpus(repo);
  assert.ok(mounted, 'a corpus was found');
  assert.equal(mounted!.origin, 'coolapp-9f3a2b');
  assert.equal(mounted!.findings.length, 1);
  assert.equal(mounted!.findings[0].id, 'cairn-0001');
});

test('loadSearchable in a project cwd returns machine + project, project namespaced', () => {
  /* Machine corpus gets its own finding; the project gets another with the SAME
   * native id, to prove namespacing keeps them apart. */
  fs.writeFileSync(path.join(MACHINE, 'cairn', 'cairn-0001.json'), JSON.stringify(finding('cairn-0001', 'a machine trap')));
  const repo = repoWithCorpus('app-77aa22', 'cairn-0001');

  const probe = path.join(repo, 'probe.ts');
  fs.writeFileSync(
    probe,
    `import { loadSearchable } from ${JSON.stringify(path.join(REPO, 'src/lib/cairn/federation'))};` +
      `console.log(JSON.stringify(loadSearchable().findings.map((f) => f.displayId || f.id)));`,
  );
  const out = execFileSync(TSX, [probe], { cwd: repo, env: { ...process.env, CAIRN_HOME: MACHINE }, encoding: 'utf8' });
  const ids: string[] = JSON.parse(out.trim().split('\n').pop()!);

  assert.ok(ids.includes('cairn-0001'), 'the machine finding is present under its native id');
  assert.ok(ids.includes('app-77aa22:cairn-0001'), 'the project finding is present, namespaced by its origin');
  assert.equal(ids.filter((i) => i.endsWith('cairn-0001')).length, 2, 'both, kept distinct — no collision');
});
