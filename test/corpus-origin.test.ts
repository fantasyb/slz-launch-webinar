/**
 * A corpus's origin is the one thing that keeps two corpora's ids apart when they
 * meet. The properties that matter: it is UNIQUE per corpus (the phantom-finding
 * fix — two corpora never share an origin, so their cairn-0050s are distinct), it
 * is STABLE once set (changing it orphans every namespaced reference), and a legacy
 * corpus carrying the old shared "cairn.local" placeholder is upgraded to a unique one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ensureOrigin } from '../src/lib/cairn/corpusOrigin';

function homeDir(name: string): string {
  const d = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-origin-')), name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

test('every corpus gets a distinct origin', () => {
  const a = ensureOrigin(homeDir('pilot'));
  const b = ensureOrigin(homeDir('pilot')); // same directory NAME, different corpus
  assert.ok(a.created && b.created);
  assert.notEqual(a.origin, b.origin, 'two corpora never share an origin, even with the same name');
  assert.match(a.origin, /^pilot-[0-9a-f]{6}$/, 'origin is the corpus name plus random bytes');
});

test('origin is stable across calls', () => {
  const h = homeDir('myrepo');
  const first = ensureOrigin(h);
  const second = ensureOrigin(h);
  assert.equal(second.created, false, 'the second call did not mint a new origin');
  assert.equal(second.origin, first.origin, 'and returned the same one');
});

test('a project corpus takes its stem from the repo, not ".cairn"', () => {
  const repo = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-repo-')), 'coolproject');
  fs.mkdirSync(repo, { recursive: true });
  const o = ensureOrigin(path.join(repo, '.cairn'));
  assert.match(o.origin, /^coolproject-[0-9a-f]{6}$/, 'named after the repo, not the .cairn dir');
});

test('a legacy "cairn.local" config is upgraded to a unique origin', () => {
  const h = homeDir('legacy');
  fs.writeFileSync(path.join(h, 'cairn.config.json'), JSON.stringify({ origin: 'cairn.local', upstreams: [] }));
  const o = ensureOrigin(h);
  assert.equal(o.created, true, 'the shared placeholder was replaced');
  assert.notEqual(o.origin, 'cairn.local');
  const onDisk = JSON.parse(fs.readFileSync(path.join(h, 'cairn.config.json'), 'utf8'));
  assert.equal(onDisk.origin, o.origin, 'and persisted');
});
