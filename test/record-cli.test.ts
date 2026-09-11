/**
 * cairn-record from a non-TTY, the way every agent harness runs it.
 *
 * The first external dogfood crew's first record died with EAGAIN out of
 * node:fs: stdin was a pipe their harness wrote to a beat after spawning, and
 * `fs.readFileSync(0)` on a non-blocking pipe with nothing in it yet throws
 * instead of waiting. Three stdin shapes are pinned here — the late writer
 * that used to crash, the pipe nobody writes to, and the `ignore` fd — and
 * the two that cannot record must say exactly what would.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

const REPO = process.cwd();
const SCRIPT = path.join(REPO, 'scripts', 'record.ts');
const TSX = path.join(REPO, 'node_modules', '.bin', 'tsx');

function fixtureHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-record-cli-'));
  fs.mkdirSync(path.join(home, 'cairn'));
  return home;
}

const submission = {
  title: 'a non-TTY record probe about the uploader',
  claim: 'The uploader rejects a region name the template lacks and never lists the names it would accept.',
  expectation: 'The error lists the regions the template accepts.',
  reality: 'It names the region it rejected and nothing else.',
  evidence: [{ command: 'uploader --region sidebar', output: 'Invalid region name: sidebar' }],
  check: { command: 'Run the uploader naming a region the template lacks and read the error.', confirmedIf: 'the error names only the rejected region', refutedIf: 'the error lists the valid regions' },
  by: 'crew-agent',
};

interface Run { code: number | null; out: string }
function run(home: string, stdin: 'pipe' | 'ignore', write?: (s: NodeJS.WritableStream) => void): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(TSX, [SCRIPT], {
      cwd: REPO,
      env: { ...process.env, CAIRN_HOME: home, CAIRN_POLICY: path.join(home, 'no-policy.json') },
      stdio: [stdin, 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout!.on('data', (d) => (out += d));
    child.stderr!.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
    if (stdin === 'pipe' && write && child.stdin) write(child.stdin);
  });
}

test('a pipe written to AFTER the process starts is read, not EAGAIN-ed (the agent-harness shape)', async () => {
  const home = fixtureHome();
  const r = await run(home, 'pipe', (s) => {
    setTimeout(() => { s.write(JSON.stringify(submission)); s.end(); }, 400);
  });
  assert.doesNotMatch(r.out, /EAGAIN/, r.out);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /recorded cairn-0001/, r.out);
  assert.equal(fs.readdirSync(path.join(home, 'cairn')).filter((f) => f.endsWith('.json')).length, 1, 'the finding was written');
});

test('a pipe nobody writes to fails fast, naming --file and stdin, with no stack trace', async () => {
  const home = fixtureHome();
  const r = await run(home, 'pipe', (s) => s.end());
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /stdin is not a TTY and nothing arrived/, r.out);
  assert.match(r.out, /pass --file <finding\.json>, or pipe the JSON on stdin/, r.out);
  assert.doesNotMatch(r.out, /node:fs|at Object\./, 'no stack trace');
  assert.equal(fs.readdirSync(path.join(home, 'cairn')).length, 0, 'nothing was written');
});

test('--help and -h print usage and exit 0 at once, before the stdin window opens', async () => {
  for (const flag of ['--help', '-h']) {
    const home = fixtureHome();
    const started = Date.now();
    /* stdin is a pipe that is never written to and never closed: the shape that used to wait 5s. */
    const r = await new Promise<Run>((resolve) => {
      const child = spawn(TSX, [SCRIPT, flag], { cwd: REPO, env: { ...process.env, CAIRN_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      child.stdout!.on('data', (d) => (out += d));
      child.stderr!.on('data', (d) => (out += d));
      child.on('close', (code) => resolve({ code, out }));
    });
    const elapsed = Date.now() - started;
    assert.equal(r.code, 0, `${flag}: ${r.out}`);
    assert.match(r.out, /usage: cairn-record --file <finding\.json>/, r.out);
    assert.doesNotMatch(r.out, /stdin is not a TTY/, 'help does not consult stdin');
    assert.ok(elapsed < 4000, `${flag} answered in ${elapsed}ms — it must not sit in the 5s stdin window`);
  }
});

test('an `ignore` stdin (fd from /dev/null) gets the same actionable refusal', async () => {
  const home = fixtureHome();
  const r = await run(home, 'ignore');
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /pass --file <finding\.json>/, r.out);
  assert.doesNotMatch(r.out, /EAGAIN/);
});
