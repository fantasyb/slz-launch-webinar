/**
 * The record reflex, on the install default, end to end through gateway tools.
 *
 * The gateway delivers (0052/0053 rode on the crew's GitHub door), but the
 * first two earned findings came through the `cairn:record` CLI hunt, not the
 * in-session reflex. Whether a model CHOOSES to record is its own behaviour;
 * what this pins is everything short of that choice, on the shape
 * `cairn:install` actually writes: a door with `--no-cairn-tools` and the
 * standalone `cairn` server alongside.
 *
 *   - the record tools are reachable in the session: not on the door, on the
 *     standalone, and the door SAYS so at connect and in every nudge;
 *   - a burned result carries the invitation; the fail-then-succeed draft
 *     rides on the recovery and lands in drafts/;
 *   - doing exactly what the nudge says, through the only LISTED tools, works:
 *     cairn_note, then cairn_record with `note:` finishes the note; the finding
 *     lands in the throwaway corpus as agentRecorded, private, unsigned, aging;
 *     {"discard"} drops a note; {"dismiss","as"} and `arc` answer a Bash-hook
 *     arc. Before this each of those either silently dropped the key (note left
 *     open, arc uncounted) or failed validation ("Required at title") at the
 *     moment the nudge asked for the call.
 *
 * Throwaway HOME, throwaway corpus, throwaway arcs file. Nothing real is
 * touched, no real credential, nothing auto-written: every record here is an
 * explicit tool call, the way an agent would make it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FindingSchema } from '../src/lib/cairn/schema';
import { verification } from '../src/lib/cairn/attest';

const REPO = process.cwd();
const INSTALL = path.join(REPO, 'scripts', 'install-global.ts');
const RECORDS = path.join(REPO, 'fixtures', 'mcp', 'records.mjs');

type Entry = { command: string; args: string[]; env: Record<string, string> };
const text = (r: unknown) => ((r as { content: Array<{ text?: string }> }).content).map((b) => b.text ?? '').join('\n');
const blocksBehind = (r: unknown) => text(r).split('\n').slice(1).join('\n');

test('on a cairn:install door the record reflex can fire unaided: nudged, reachable, and a record lands via the gateway tools', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-reflex-'));
  const corpus = path.join(home, 'pilot');
  const arcs = path.join(home, 'arcs.jsonl');
  fs.mkdirSync(path.join(home, '.claude'));
  const claudeJson = path.join(home, '.claude.json');
  fs.writeFileSync(claudeJson, JSON.stringify({ mcpServers: { github: { command: 'node', args: [RECORDS] } } }, null, 2));
  fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), '# notes\n');
  execFileSync('npx', ['tsx', INSTALL, '--home', corpus, '--no-daemon'], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
  const cfg = (JSON.parse(fs.readFileSync(claudeJson, 'utf8')) as { mcpServers: Record<string, Entry> }).mcpServers;
  assert.ok(cfg.github.args.includes('--no-cairn-tools'), 'the install shape under test: the door lists no cairn tools of its own');
  assert.ok(cfg.cairn, 'and the standalone cairn server sits alongside');

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
  delete env.CAIRN_EVAL;
  Object.assign(env, { HOME: home, CAIRN_ARCS: arcs });
  const open = async (name: string) => {
    const c = new Client({ name: 'crew', version: '0' }, { capabilities: {} });
    await c.connect(new StdioClientTransport({ command: cfg[name].command, args: cfg[name].args, env: { ...env, ...cfg[name].env }, stderr: 'pipe' }));
    return c;
  };
  const door = await open('github');
  const cairn = await open('cairn');
  try {
    /* REACHABLE, AND SAID. */
    const doorTools = (await door.listTools()).tools.map((t) => t.name);
    const cairnTools = (await cairn.listTools()).tools.map((t) => t.name);
    assert.ok(!doorTools.some((t) => t.startsWith('cairn_')), `the door lists no cairn tool: ${doorTools.join(', ')}`);
    for (const t of ['cairn_record', 'cairn_note', 'cairn_observe', 'cairn_find']) assert.ok(cairnTools.includes(t), `${t} is listed on the standalone server`);
    assert.match(door.getInstructions() ?? '', /on the `cairn` server in this same session/, 'the door tells the agent where the record tools are');

    /* BURNED, THEN RECOVERED: the invitation, then the draft. */
    const bad = await door.callTool({ name: 'query_records', arguments: { object: 'Contact', filter: { nonsense: 'x' } } });
    assert.equal(bad.isError, true);
    assert.match(blocksBehind(bad), /Nothing is recorded about this failure[\s\S]*cairn_record \(on the `cairn` server in this session/, 'the burned result invites a record and says where the tool is');
    const good = await door.callTool({ name: 'query_records', arguments: { object: 'Contact', filter: { status: 'churned' }, limit: 2 } });
    assert.ok(!good.isError);
    const draft = blocksBehind(good);
    assert.match(draft, /Earlier in this session query_records failed and this call succeeded/, 'the draft rides on the recovery');
    assert.match(draft, /cairn_record \(on the `cairn` server in this session; this server does not list it\)/, 'and points at the listed tool');
    assert.ok(fs.readdirSync(path.join(corpus, 'drafts')).some((f) => f.endsWith('-query_records.json')), 'the draft is on disk under the corpus home');

    /* DO WHAT THE NUDGE SAYS, THROUGH THE ONLY LISTED TOOLS. */
    const evidence = [{ command: 'query_records {"object":"Contact","filter":{"nonsense":"x"}}', output: text(bad).split('\n')[0].slice(0, 300) }];
    const noted = await cairn.callTool({ name: 'cairn_note', arguments: { title: 'query_records refuses an unknown filter field with a bare error', tool: 'query_records', evidence, by: 'crew' } });
    assert.equal(noted.isError ?? false, false, text(noted));
    const noteId = /note-[a-z0-9]+-[a-f0-9]+/.exec(text(noted))?.[0];
    assert.ok(noteId, 'the note has an id');
    const recorded = await cairn.callTool({
      name: 'cairn_record',
      arguments: {
        title: 'query_records errors on an unknown filter field instead of ignoring it',
        claim: 'query_records on the records fixture returns an error result for a filter naming a field the object does not have, rather than ignoring the field or returning zero rows.',
        expectation: 'An unknown filter field is ignored or yields zero rows, like most query APIs.',
        reality: 'The call returns an error result naming the unknown field; the same query with a known field succeeds.',
        workaround: "Check the object's fields with describe_object before filtering.",
        tool: 'query_records',
        evidence: [...evidence, { command: 'query_records {"object":"Contact","filter":{"status":"churned"},"limit":2}', output: '(succeeded)' }],
        check: { command: 'Call query_records with a filter naming a field describe_object does not list; confirm it errors rather than returning rows.', confirmedIf: 'the call returns an error result naming the field', refutedIf: 'the call succeeds, ignoring the field or returning zero rows' },
        by: 'crew',
        note: noteId,
      },
    });
    assert.equal(recorded.isError ?? false, false, text(recorded));
    assert.match(text(recorded), /Recorded cairn-0001/);
    assert.match(text(recorded), new RegExp(`Finished note ${noteId}`), 'cairn_record with note: finishes the note (it used to be dropped silently)');
    const noteFile = fs.readdirSync(path.join(corpus, 'drafts')).find((f) => f.startsWith(noteId!))!;
    const note = JSON.parse(fs.readFileSync(path.join(corpus, 'drafts', noteFile), 'utf8')) as { status: string; findingId?: string };
    assert.equal(note.status, 'finished');
    assert.equal(note.findingId, 'cairn-0001');

    /* THE RECORD, AS IT LANDED: agent-origin, private, unsigned, aging. Never auto-written; never promoted. */
    const landed = fs.readdirSync(path.join(corpus, 'cairn')).filter((f) => f.endsWith('.json'));
    assert.equal(landed.length, 1, `one finding in the throwaway corpus: ${landed.join(', ')}`);
    const finding = FindingSchema.parse(JSON.parse(fs.readFileSync(path.join(corpus, 'cairn', landed[0]), 'utf8')));
    assert.equal(finding.agentRecorded, true);
    assert.equal(finding.visibility, 'private');
    assert.deepEqual(finding.triggers, ['query_records']);
    assert.equal(finding.observations.length, 1);
    assert.equal(finding.observations[0].by, 'crew');
    assert.equal(finding.observations[0].signature, undefined, 'unsigned: an agent record is never machine-signed');
    assert.equal(verification(finding).standing, 'aging', 'born aging, not fresh');

    /* THE OTHER PATHS THE NUDGES NAME. */
    const second = await cairn.callTool({ name: 'cairn_note', arguments: { title: 'a second note to drop', tool: 'query_records', evidence, by: 'crew' } });
    const secondId = /note-[a-z0-9]+-[a-f0-9]+/.exec(text(second))?.[0];
    const dropped = await cairn.callTool({ name: 'cairn_note', arguments: { discard: secondId } });
    assert.equal(dropped.isError ?? false, false, `{"discard"} used to fail validation: ${text(dropped)}`);
    assert.match(text(dropped), new RegExp(`Discarded ${secondId}`));
    const noAs = await cairn.callTool({ name: 'cairn_note', arguments: { dismiss: 'arc-0123abcd' } });
    assert.equal(noAs.isError, true);
    assert.match(text(noAs), /dismiss needs `as`/);
    const unknownArc = await cairn.callTool({ name: 'cairn_note', arguments: { dismiss: 'arc-0123abcd', as: 'my-mistake' } });
    assert.equal(unknownArc.isError, true, 'an arc nobody offered cannot be answered');
    /* An arc the Bash hook offered, banked through the standalone: counted beside the offer, in the throwaway arcs file. */
    fs.writeFileSync(arcs, `${JSON.stringify({ at: new Date().toISOString(), arc: 'arc-0123abcd', key: 'query_records', failing: 'x', choice: 'offered' })}\n`);
    const banked = await cairn.callTool({ name: 'cairn_note', arguments: { title: 'banked from an arc', tool: 'query_records', evidence, by: 'crew', arc: 'arc-0123abcd' } });
    assert.equal(banked.isError ?? false, false, text(banked));
    const rows = fs.readFileSync(arcs, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { arc: string; choice: string; by?: string });
    assert.deepEqual(rows.map((r) => r.choice), ['offered', 'bank'], 'the answer sits beside the offer');
    assert.equal(rows[1].by, 'crew');
    /* A note only: nothing else landed in the corpus. */
    assert.equal(fs.readdirSync(path.join(corpus, 'cairn')).filter((f) => f.endsWith('.json')).length, 1, 'a note is not a finding; the corpus did not grow');
  } finally {
    await door.close();
    await cairn.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
