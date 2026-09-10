/**
 * A finding's `mechanism` is the author's post-hoc story. Every check the
 * corpus has is symptom-level — the gate, doctor and cairn_observe all test
 * whether the trap BIT, never why — so nothing ever verifies the mechanism, and
 * a working fix with a wrong explanation passes forever. So the served block
 * carries symptom and fix only, and wherever the mechanism IS rendered it is
 * labelled as inference. Pinned in the source, the way the daemon guards are.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), 'utf8');
const LABEL = /author'?s inference, unverified|author&apos;s inference, unverified/;

test('the default served block (gateway result note, cairn_find) renders reality and workaround, never the mechanism', () => {
  const proxy = read('scripts', 'mcp-proxy.ts');
  const fullNote = proxy.slice(proxy.indexOf('function fullNote('), proxy.indexOf('function reminderNote('));
  assert.match(fullNote, /WHAT HAPPENS: \$\{clip\(f\.reality/, 'the symptom is served');
  assert.match(fullNote, /INSTEAD: \$\{clip\(f\.workaround/, 'and the fix');
  assert.doesNotMatch(fullNote, /f\.mechanism/, 'the story is not');
  const server = read('scripts', 'mcp-server.ts');
  assert.doesNotMatch(server, /\.mechanism/, 'cairn_find on the standalone server serves ACTUALLY/INSTEAD only');
});

test('wherever the mechanism is rendered, it is labelled as the author\'s unverified inference', () => {
  assert.match(read('scripts', 'expand.ts'), /MECHANISM \(author's inference, unverified\)/);
  assert.match(read('src', 'app', 'findings', '[id]', 'page.tsx'), LABEL);
});
