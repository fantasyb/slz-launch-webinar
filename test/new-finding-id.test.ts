/**
 * The id `cairn:new` mints must never collide with one already in the corpus.
 *
 * The old generator sliced the number from the first four characters of the
 * filename (`parseInt(f.slice(0,4))`) and trusted that over the record — which
 * truncates a five-digit id and, with no collision guard, can mint the same
 * number twice. These tests drive the real script against a temp corpus and
 * check the number it chooses.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const REPO = process.cwd();
const SCRIPT = path.join(REPO, 'scripts', 'new-finding.ts');

/** A temp CAIRN_HOME whose cairn/ holds findings with the given numeric ids. */
function homeWith(ids: number[]): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-idgen-'));
  const dir = path.join(home, 'cairn');
  fs.mkdirSync(dir);
  for (const n of ids) {
    const num = String(n).padStart(4, '0');
    fs.writeFileSync(path.join(dir, `${num}-x.json`), JSON.stringify({ id: `cairn-${num}` }));
  }
  return home;
}

/** Run cairn:new and return the id it created (read from the new file's id field). */
function mint(home: string, before: Set<string>): string {
  execFileSync('npx', ['tsx', SCRIPT, 'a new finding'], { cwd: REPO, env: { ...process.env, CAIRN_HOME: home }, stdio: 'ignore' });
  const dir = path.join(home, 'cairn');
  const added = fs.readdirSync(dir).filter((f) => !before.has(f));
  assert.equal(added.length, 1, `exactly one file was created (got ${added.join(', ')})`);
  return JSON.parse(fs.readFileSync(path.join(dir, added[0]), 'utf8')).id as string;
}

test('the next id is max+1 across the corpus', () => {
  const home = homeWith([1, 2, 9, 50]);
  const before = new Set(fs.readdirSync(path.join(home, 'cairn')));
  assert.equal(mint(home, before), 'cairn-0051', 'takes the true max, not a fixed number');
});

test('a used number in a gap is skipped, never reused', () => {
  // Highest is 5, but 3 is missing and 5 exists. max+1 = 6, which is free.
  const home = homeWith([1, 2, 5]);
  const before = new Set(fs.readdirSync(path.join(home, 'cairn')));
  assert.equal(mint(home, before), 'cairn-0006', 'max+1, and it is not already used');
});

test('a five-digit id is read from the id field, not truncated by the filename slice', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-idgen-'));
  const dir = path.join(home, 'cairn');
  fs.mkdirSync(dir);
  // The old slice(0,4) would read "1000" from "10000-...", minting cairn-1001.
  fs.writeFileSync(path.join(dir, '10000-x.json'), JSON.stringify({ id: 'cairn-10000' }));
  const before = new Set(fs.readdirSync(dir));
  assert.equal(mint(home, before), 'cairn-10001', 'the five-digit id is honored');
});
