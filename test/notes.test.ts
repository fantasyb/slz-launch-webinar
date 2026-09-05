/**
 * The second tier, and the property that is its entire safety argument:
 * a note is unreachable by construction. It lives in drafts/, and
 * cairn_find, the gateway index and federationBundle() all read cairn/.
 * This test writes a note and then asks every reader the corpus has whether
 * it can see it. If any of them ever can, the tier has become a wiki.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-notes-test-'));
fs.mkdirSync(path.join(home, 'cairn'));
process.env.CAIRN_HOME = home; /* before the first import resolves it */
process.env.CAIRN_POLICY = path.join(home, 'no-policy.json');

const minimal = {
  title: 'deploy fails with an invalid region name and the error never lists the valid ones',
  tool: 'deploy_metadata',
  evidence: [{ command: 'deploy_metadata {"path":"force-app"}', output: 'Invalid region name: sidebar' }],
  by: 'test-agent',
};

test('a note takes what the session has and nothing that needs thought, and lands in drafts/, never cairn/', async () => {
  const { recordNote } = await import('../src/lib/cairn/notes');
  const r = recordNote(minimal);
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /^Noted \(note-[a-z0-9-]+\); not a finding until claim, expectation, reality and check are filled/);
  assert.ok(r.file!.startsWith(path.join(home, 'drafts')));
  assert.equal(fs.readdirSync(path.join(home, 'cairn')).length, 0, 'nothing entered the corpus');
  assert.equal(fs.readFileSync(path.join(home, 'drafts', '.gitignore'), 'utf8'), '*\n');
});

test('a note is unreachable by every reader the corpus has', async () => {
  const { loadCorpus } = await import('../src/lib/cairn/load');
  const { loadSearchable, federationBundle } = await import('../src/lib/cairn/federation');
  const { retrieve } = await import('../src/lib/cairn/retrieval');
  assert.equal(loadCorpus().length, 0, 'loadCorpus does not see it');
  const searchable = loadSearchable().findings;
  assert.equal(searchable.length, 0, 'loadSearchable does not see it');
  assert.equal(federationBundle().findings.length, 0, 'federationBundle does not see it');
  assert.deepEqual(retrieve(minimal.title, searchable, { limit: 5 }), [], 'retrieve cannot return it');
});

test('the secret gate is not tiered', async () => {
  const { recordNote } = await import('../src/lib/cairn/notes');
  const r = recordNote({ ...minimal, evidence: [{ command: 'x', output: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789' }] });
  assert.equal(r.ok, false);
  assert.match(r.message, /auth-header/);
  assert.match(r.message, /accepted if written as/);
});

test('open, abandoned after fourteen days, finished by the finding it became, discarded', async () => {
  const { recordNote, listNotes, openNotesFor, finishNotes, discardNote, ABANDON_AFTER_DAYS } = await import('../src/lib/cairn/notes');
  const old = recordNote({ ...minimal, title: 'an old note about the same tool nobody finished', tool: 'deploy_metadata' });
  const file = old.file!;
  const stale = JSON.parse(fs.readFileSync(file, 'utf8'));
  stale.at = new Date(Date.now() - (ABANDON_AFTER_DAYS + 1) * 86_400_000).toISOString();
  fs.writeFileSync(file, JSON.stringify(stale));
  const states = Object.fromEntries(listNotes().map((n) => [n.note.id, n.state]));
  assert.equal(states[stale.id], 'abandoned');
  assert.ok(!openNotesFor(['deploy_metadata', 'mcp__sf__deploy_metadata']).some((n) => n.id === stale.id), 'an abandoned note is never offered');
  const offered = openNotesFor(['mcp__sf__deploy_metadata', 'deploy_metadata']);
  assert.ok(offered.length >= 1 && offered.every((n) => n.tool === 'deploy_metadata'));

  const fresh = offered[0];
  const closedById = finishNotes({ id: 'cairn-0001', title: 'unrelated title entirely', triggers: ['other_tool'] }, fresh.id);
  assert.deepEqual(closedById.map((n) => n.id), [fresh.id], 'finished by id whatever the title');
  assert.equal(listNotes().find((n) => n.note.id === fresh.id)!.note.findingId, 'cairn-0001');

  const another = recordNote({ ...minimal, title: 'invalid region name deploy error never lists valid region names' }).note!;
  const closedByTrap = finishNotes({ id: 'cairn-0002', title: 'deploy fails on an invalid region name and never lists the valid region names', triggers: ['deploy_metadata'] });
  assert.ok(closedByTrap.some((n) => n.id === another.id), 'finished by the same tool and a title that reads as the same trap');

  const third = recordNote({ ...minimal, title: 'something else about the deploy tool' }).note!;
  assert.equal(discardNote(third.id)?.status, 'discarded');
  assert.equal(discardNote('note-nope'), null);
});

