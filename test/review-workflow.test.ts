import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const workflow = fs.readFileSync('.github/workflows/cairn-review.yml', 'utf8');
function script(name: string): string {
  const rest = workflow.split(`      - name: ${name}\n`)[1];
  assert.ok(rest, `missing step: ${name}`);
  const body = rest.split('        run: |\n')[1];
  assert.ok(body, `missing shell body: ${name}`);
  return body.split('\n').slice(0, body.split('\n').findIndex((line) => line !== '' && !line.startsWith('          ')))
    .map((line) => line.slice(10)).join('\n');
}

test('review rejects a base without tooling before installing dependencies', () => {
  assert.match(workflow, /ref: \$\{\{ steps\.tooling\.outputs\.sha \}\}/);
  assert.match(workflow, /BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.ok(workflow.indexOf('Require trusted review tooling') < workflow.indexOf('- run: npm ci'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-review-preflight-'));
  try {
    const required = ['cairn:lint', 'cairn:audit', 'test', 'cairn:adjudicate', 'cairn:review'];
    for (const missing of [null, ...required]) {
      const scripts = Object.fromEntries(required.filter((name) => name !== missing).map((name) => [name, 'true']));
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts }));
      const result = spawnSync('bash', ['-c', script('Require trusted review tooling')], { cwd: dir, encoding: 'utf8' });
      assert.equal(result.status, missing ? 1 : 0, result.stderr);
      if (missing) assert.match(result.stderr, /Land the independently reviewed Cairn tooling/);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('trusted tooling pins accept only full commit hashes and default to the base', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-review-pin-'));
  const output = path.join(dir, 'output');
  const base = '1'.repeat(40);
  try {
    for (const approved of ['', '2'.repeat(40), 'main', 'refs/pull/3/head', '$(touch injected)', 'abc123']) {
      fs.writeFileSync(output, '');
      const result = spawnSync('bash', ['-c', script('Resolve trusted tooling revision')], {
        cwd: dir, encoding: 'utf8', env: { ...process.env, APPROVED_SHA: approved, BASE_SHA: base, GITHUB_OUTPUT: output },
      });
      const valid = approved === '' || /^[0-9a-f]{40}$/.test(approved);
      assert.equal(result.status, valid ? 0 : 1, result.stderr);
      assert.equal(fs.readFileSync(output, 'utf8'), valid ? `sha=${approved || base}\n` : '');
      assert.equal(fs.existsSync(path.join(dir, 'injected')), false);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('lint warnings pass but unexpected tool failures do not', () => {
  for (const code of [0, 1, 2, 3, 127]) {
    const result = spawnSync('bash', ['-c', `npm() { return ${code}; }\n${script('Corpus lint')}`], { encoding: 'utf8' });
    assert.equal(result.status, code === 2 ? 0 : code, result.stderr);
  }
});
