/**
 * The updater's whole job is to be safe when unattended: fast-forward or refuse,
 * and never touch the operator's work. These tests drive it against real git
 * repositories — a bare "remote" and a checkout of it — because the properties
 * that matter (dirty tree stops it, a diverged checkout stops it, a bad build
 * rolls back to the exact prior commit) are git behaviours, not arithmetic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { selfUpdate } from '../src/lib/cairn/selfUpdate';

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

/** A bare remote with one commit on `main`, and a checkout of it. */
function scaffold(): { remote: string; checkout: string; head: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-update-'));
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  const checkout = path.join(root, 'checkout');
  execFileSync('git', ['init', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['init', '-b', 'main', seed]);
  const id = (d: string) => { git(d, 'config', 'user.email', 't@t'); git(d, 'config', 'user.name', 't'); };
  id(seed);
  fs.writeFileSync(path.join(seed, 'package.json'), '{"name":"cairn"}');
  git(seed, 'add', '-A'); git(seed, 'commit', '-m', 'seed');
  git(seed, 'remote', 'add', 'origin', remote); git(seed, 'push', 'origin', 'main');
  execFileSync('git', ['clone', remote, checkout]);
  id(checkout);
  return { remote, checkout, head: git(checkout, 'rev-parse', 'HEAD') };
}

/** Add a commit to the remote via a throwaway clone, so the checkout is behind. */
function advanceRemote(remote: string, file = 'new.txt'): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-adv-'));
  execFileSync('git', ['clone', remote, tmp]);
  git(tmp, 'config', 'user.email', 't@t'); git(tmp, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(tmp, file), 'x');
  git(tmp, 'add', '-A'); git(tmp, 'commit', '-m', `add ${file}`); git(tmp, 'push', 'origin', 'main');
}

const ok = () => true;

test('up to date is a no-op', () => {
  const { checkout } = scaffold();
  const r = selfUpdate({ repoDir: checkout, build: ok });
  assert.equal(r.status, 'up-to-date');
});

test('a checkout behind the pin fast-forwards and reports how far', () => {
  const { remote, checkout, head } = scaffold();
  advanceRemote(remote);
  const r = selfUpdate({ repoDir: checkout, build: ok });
  assert.equal(r.status, 'updated', r.reason);
  assert.equal(r.from, head);
  assert.equal(r.advanced, 1);
  assert.ok(fs.existsSync(path.join(checkout, 'new.txt')), 'the new commit is in the tree');
});

test('a dirty working tree stops the update, work untouched', () => {
  const { remote, checkout } = scaffold();
  advanceRemote(remote);
  fs.writeFileSync(path.join(checkout, 'package.json'), '{"name":"cairn","local":true}');
  const r = selfUpdate({ repoDir: checkout, build: ok });
  assert.equal(r.status, 'skipped');
  assert.match(r.reason!, /local changes/);
  assert.match(fs.readFileSync(path.join(checkout, 'package.json'), 'utf8'), /local/, 'the local edit survives');
});

test('a diverged checkout is never force-updated', () => {
  const { remote, checkout } = scaffold();
  advanceRemote(remote); // remote ahead by one
  fs.writeFileSync(path.join(checkout, 'mine.txt'), 'local');
  git(checkout, 'add', '-A'); git(checkout, 'commit', '-m', 'my local commit'); // checkout ahead by one too
  const r = selfUpdate({ repoDir: checkout, build: ok });
  assert.equal(r.status, 'skipped');
  assert.match(r.reason!, /local commit/);
  assert.ok(fs.existsSync(path.join(checkout, 'mine.txt')), 'the local commit is intact');
});

test('a build that fails rolls back to the exact prior commit', () => {
  const { remote, checkout, head } = scaffold();
  advanceRemote(remote);
  const r = selfUpdate({ repoDir: checkout, build: () => false });
  assert.equal(r.status, 'rolled-back');
  assert.equal(git(checkout, 'rev-parse', 'HEAD'), head, 'HEAD is back where it started');
  assert.ok(!fs.existsSync(path.join(checkout, 'new.txt')), 'the pulled file was reverted');
});

test('dry run reports the fast-forward without doing it', () => {
  const { remote, checkout, head } = scaffold();
  advanceRemote(remote);
  const r = selfUpdate({ repoDir: checkout, build: ok, dryRun: true });
  assert.equal(r.status, 'skipped');
  assert.match(r.reason!, /would fast-forward 1/);
  assert.equal(git(checkout, 'rev-parse', 'HEAD'), head, 'nothing changed');
});

test('not a git checkout is a clean skip, never a throw', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-nogit-'));
  const r = selfUpdate({ repoDir: dir, build: ok });
  assert.equal(r.status, 'skipped');
  assert.match(r.reason!, /not a git checkout/);
});

test('with signing required, an unverified target is refused before the tree moves', () => {
  const { remote, checkout, head } = scaffold();
  advanceRemote(remote);
  // Inject a verifier that rejects (as `git verify-commit` would on an unsigned
  // commit): the update must refuse WITHOUT fast-forwarding.
  const r = selfUpdate({ repoDir: checkout, build: ok, requireSigned: true, verify: () => false });
  assert.equal(r.status, 'skipped', r.reason);
  assert.match(r.reason ?? '', /not a verified signed commit/);
  assert.equal(git(checkout, 'rev-parse', 'HEAD'), head, 'the checkout was not moved to the unverified commit');
});

test('with signing required, a verified target still fast-forwards', () => {
  const { remote, checkout } = scaffold();
  advanceRemote(remote);
  const r = selfUpdate({ repoDir: checkout, build: ok, requireSigned: true, verify: () => true });
  assert.equal(r.status, 'updated', r.reason);
});

test('without signing required, verification is not consulted (default dev flow)', () => {
  const { remote, checkout } = scaffold();
  advanceRemote(remote);
  let called = false;
  const r = selfUpdate({ repoDir: checkout, build: ok, verify: () => { called = true; return false; } });
  assert.equal(r.status, 'updated', r.reason);
  assert.equal(called, false, 'verify is not called unless signing is required');
});
