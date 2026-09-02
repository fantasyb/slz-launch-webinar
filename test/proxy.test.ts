/**
 * The proxy forwards everything, adds only labelled text, and never withholds.
 *
 * Push delivery is the binding constraint — cairn-0035 measured that an agent
 * which does not ask gets nothing — and two things reach the model in every
 * client with no feature to negotiate: a tool's result, which it always
 * reads, and a tool's description, which it reads before deciding to call.
 * The proxy uses both, and every property below is checked over real stdio
 * against a real upstream, because the gap that has bitten three times today
 * is between "the function returns the right string" and "the model receives
 * it".
 *
 * The driver is interactive rather than a batch of requests behind a timeout,
 * because half of what matters here is ORDER: the second call to a tool must
 * not repeat the first call's finding, a finding banked between two listings
 * must appear in the second, and an upstream that died must be back for the
 * call after the one it died on.
 *
 * Assertions are on text the proxy could only have produced — a finding's
 * title or id, an upstream's resource body — never on text that was in the
 * request, because a grep for the query finds the query echoed back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';

const REPO = process.cwd();
const FIXTURE = path.join(REPO, 'fixtures', 'mcp', 'upstream.mjs');

type Msg = { id?: number; method?: string; params?: unknown; result?: unknown; error?: unknown };

/** A private corpus. `withFinding` adds one finding about the fixture's query tool. */
function corpus(withFinding = true): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-proxy-'));
  fs.mkdirSync(path.join(home, 'cairn'));
  if (withFinding) bank(home, '0001-tool.json', 'cairn-0001', 'the query tool returns empty rather than erroring on a stale mapping', 'mcp__data360__query_records');
  return home;
}

function bank(home: string, file: string, id: string, title: string, trigger: string, extraTriggers: string[] = []): void {
  const donor = JSON.parse(
    fs.readFileSync(path.join(REPO, 'cairn', fs.readdirSync(path.join(REPO, 'cairn'))[0]), 'utf8'),
  );
  fs.writeFileSync(
    path.join(home, 'cairn', file),
    JSON.stringify({
      ...donor,
      id,
      title,
      reality: 'the call succeeds and returns zero rows',
      workaround: 'check the mapping timestamp before trusting a zero-row result',
      triggers: [trigger, ...extraTriggers],
      precondition: undefined,
      visibility: 'private',
      status: 'active',
      observations: [{ by: 't', at: '2026-09-01T00:00:00.000Z', verdict: 'confirmed', note: 'seen here' }],
    }),
  );
}

/** Drive the proxy over stdio: send a request, await its reply, watch notifications. */
class Session {
  private child: ChildProcess;
  private pending = new Map<number, (m: Msg) => void>();
  private next = 1;
  private buf = '';
  notifications: Msg[] = [];
  stderr = '';

  constructor(home: string, args: string[]) {
    const env: Record<string, string | undefined> = { ...process.env, CAIRN_HOME: home };
    delete env.CAIRN_SESSION;
    delete env.CAIRN_AGENT;
    /* Cast: this project augments ProcessEnv with a required NODE_ENV, which
     * a copy with two variables deleted deliberately does not carry. */
    this.child = spawn('npx', ['tsx', 'scripts/mcp-proxy.ts', ...args], {
      cwd: REPO,
      env: env as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr!.on('data', (d) => { this.stderr += String(d); });
    this.child.stdout!.on('data', (d) => {
      this.buf += String(d);
      let nl;
      while ((nl = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        let m: Msg;
        try { m = JSON.parse(line); } catch { continue; }
        if (typeof m.id === 'number' && this.pending.has(m.id)) {
          this.pending.get(m.id)!(m);
          this.pending.delete(m.id);
        } else if (m.method) {
          this.notifications.push(m);
        }
      }
    });
  }

  request(method: string, params: unknown = {}): Promise<Msg> {
    const id = this.next++;
    this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no reply to ${method} (id ${id}) in 20s\n${this.stderr}`)), 20_000);
      this.pending.set(id, (m) => { clearTimeout(t); resolve(m); });
    });
  }

  notify(method: string, params: unknown = {}): void {
    this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async init(clientName = 't-client'): Promise<Msg> {
    const r = await this.request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: clientName, version: '1' },
    });
    this.notify('notifications/initialized');
    return r;
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<{ isError?: boolean; content: { type: string; text?: string }[] }> {
    const r = await this.request('tools/call', { name, arguments: args });
    assert.ok(!r.error, `tools/call ${name} errored at the protocol level: ${JSON.stringify(r.error)}`);
    return r.result as { isError?: boolean; content: { type: string; text?: string }[] };
  }

  async tools(): Promise<Array<{ name: string; description?: string }>> {
    const r = await this.request('tools/list');
    return (r.result as { tools: Array<{ name: string; description?: string }> }).tools;
  }

  /** Hang up the way a client does, then make sure; and let go of the pipes so the runner can exit. */
  async close(): Promise<void> {
    try { this.child.stdin!.end(); } catch { /* already gone */ }
    await new Promise((r) => setTimeout(r, 300));
    try { this.child.kill('SIGKILL'); } catch { /* already gone */ }
    this.child.stdout?.destroy();
    this.child.stderr?.destroy();
  }
}

const texts = (r: { content: { text?: string }[] }) => r.content.map((c) => c.text ?? '');

/**
 * The invariant every annotation must satisfy: the tool's own content comes
 * first and intact, and every block after it carries the sender label. This is
 * what "untouched" means here -- not "nothing appended", because the index of
 * a server's traps rides on its first result by design.
 */
function intactThenLabelled(r: { content: { type: string; text?: string }[] }, own: string): void {
  assert.deepEqual(r.content[0], { type: 'text', text: own }, 'the tool\'s own content is first and intact');
  for (const c of r.content.slice(1)) assert.match(c.text ?? '', /from your Cairn corpus, not from this tool/, 'every appended block is labelled');
}
const single = (home: string) => new Session(home, ['--server', `node ${FIXTURE}`]);

test('a finding rides back on the result of the tool it is about', async () => {
  const s = single(corpus());
  try {
    const init = await s.init();
    const instructions = (init.result as { instructions?: string }).instructions ?? '';
    assert.match(instructions, /paginate with limit 50/, 'the upstream\'s own instructions must survive the proxy');
    assert.match(instructions, /from your Cairn corpus/, 'the connect-time floor for clients with no hooks');

    const r = await s.call('mcp__data360__query_records', { object: 'Account' });
    const t = texts(r);
    assert.ok(t.some((x) => x.includes('"records":[]')), 'the tool\'s own result must be returned intact');
    const note = t.find((x) => x.includes('cairn-0001'));
    assert.ok(note, 'the finding must reach the model on the result');
    assert.match(note!, /not from this tool/, 'the sender label is load-bearing, not decorative');
    assert.match(note!, /WHAT HAPPENS/);
  } finally { await s.close(); }
});

test('a tool nothing is recorded about comes back untouched, and so does a corpus that cannot be read', async () => {
  const home = corpus();
  fs.writeFileSync(path.join(home, 'cairn', '0002-broken.json'), '{ this is not json');
  const s = single(home);
  try {
    await s.init();
    intactThenLabelled(await s.call('mcp__data360__unrelated'), 'ok');
    // The broken file must not silence the good one either.
    assert.ok(texts(await s.call('mcp__data360__query_records', { object: 'A' })).some((x) => x.includes('cairn-0001')));
  } finally { await s.close(); }
});

test('an empty corpus never blocks or alters a call', async () => {
  const s = single(corpus(false));
  try {
    await s.init();
    assert.deepEqual((await s.call('mcp__data360__query_records', { object: 'A' })).content, [
      { type: 'text', text: '{"status":"success","records":[]}' },
    ]);
  } finally { await s.close(); }
});

/**
 * The before-the-call channel. A description is the one text every client
 * reads BEFORE deciding to call, so it carries one labelled line naming the
 * trap, and nothing more: descriptions are paid for on every turn.
 */
test('the tool description names the trap before any call is made', async () => {
  const s = single(corpus());
  try {
    await s.init();
    const tools = await s.tools();
    const q = tools.find((t) => t.name === 'mcp__data360__query_records')!;
    assert.match(q.description!, /returns empty rather than erroring on a stale mapping/, 'the title must be on the description');
    assert.match(q.description!, /not from this tool/);
    assert.match(q.description!, /^Query records/, 'the upstream\'s own description comes first, untouched');
    assert.equal(tools.find((t) => t.name === 'mcp__data360__unrelated')!.description, 'Something nothing is recorded about');
  } finally { await s.close(); }
});

/**
 * Before the call means before the DECISION. There is no model turn between
 * a decision and its execution, so the surfaces that can warn first are the
 * ones already in context: the instructions at connect, and prior results.
 * The proof is a trap the agent hears about on a tool it has never called.
 */
test('a trap on a tool the agent has not called yet is announced at connect and on first contact', async () => {
  const home = corpus(false);
  bank(home, '0004-fail.json', 'cairn-0004', 'the failing tool reports a mapping error for any object with a space in its name', 'mcp__data360__failing');
  const s = single(home);
  try {
    const init = await s.init();
    const instructions = (init.result as { instructions?: string }).instructions ?? '';
    assert.match(instructions, /mapping error for any object with a space/, 'the index is in the instructions at connect');

    // First contact with this upstream is a call to a DIFFERENT tool.
    const first = texts(await s.call('mcp__data360__unrelated'));
    const index = first.find((x) => x.includes('cairn-0004'));
    assert.ok(index, 'the first result from the upstream carries the index, for clients that ignore instructions');
    assert.match(index!, /Other tools from this server/);
    assert.match(index!, /not from this tool/);

    const second = texts(await s.call('mcp__data360__unrelated'));
    assert.ok(!second.some((x) => x.includes('cairn-0004')), 'the index is delivered once, not on every result');
  } finally { await s.close(); }
});

/**
 * The argument channel. A trigger naming an argument puts the finding on that
 * argument's own schema description -- read at the moment the model is
 * choosing the value, which is pre-call and argument-aware at once -- and on
 * the result only when the argument was actually supplied.
 *
 * The finding's only trigger is the two-word form, so this also proves the
 * match does not depend on preflight's one-word path.
 */
test('a finding about an argument rides on that argument\'s schema, and on results that used it', async () => {
  const home = corpus(false);
  bank(home, '0003-arg.json', 'cairn-0003', 'a stale mapping id returns an empty result with a success status', 'mcp__data360__query_records mapping_id');
  const s = single(home);
  try {
    await s.init();
    const r = await s.request('tools/list');
    const tools = (r.result as { tools: Array<{ name: string; description?: string; inputSchema: { properties: Record<string, { description?: string }> } }> }).tools;
    const q = tools.find((t) => t.name === 'mcp__data360__query_records')!;
    const arg = q.inputSchema.properties.mapping_id.description ?? '';
    assert.match(arg, /^The mapping to query through/, 'the upstream\'s own argument description comes first');
    assert.match(arg, /stale mapping id returns an empty result/, 'the finding is on the argument');
    assert.match(arg, /not from this tool/, 'the label rides inside the schema string');
    assert.equal(q.description, 'Query records', 'an argument-level finding does not also clutter the tool');
    assert.equal(q.inputSchema.properties.object.description, undefined, 'other arguments are untouched');

    const without = texts(await s.call('mcp__data360__query_records', { object: 'A' }));
    assert.ok(!without.some((x) => x.includes('cairn-0003')), 'a call that did not use the argument is not annotated');
    const withArg = texts(await s.call('mcp__data360__query_records', { object: 'A', mapping_id: 'm-1' }));
    assert.ok(withArg.some((x) => x.includes('cairn-0003')), 'a call that used the argument is');
  } finally { await s.close(); }
});

/**
 * The same finding on every call is wallpaper. Full note once, then silence,
 * then a one-line reminder on a cadence -- because compaction can drop the
 * first note from a long session and the reminder is what survives that.
 */
test('a repeated call does not repeat the finding, and a long run gets a reminder', async () => {
  const s = single(corpus());
  try {
    await s.init();
    const first = texts(await s.call('mcp__data360__query_records', { object: 'A' }));
    assert.ok(first.some((x) => x.includes('WHAT HAPPENS')));
    for (let i = 2; i <= 9; i++) {
      const t = texts(await s.call('mcp__data360__query_records', { object: 'A' }));
      assert.ok(!t.some((x) => x.includes('cairn-0001')), `call ${i} must not repeat the finding`);
    }
    const tenth = texts(await s.call('mcp__data360__query_records', { object: 'A' }));
    const reminder = tenth.find((x) => x.includes('cairn-0001'));
    assert.ok(reminder, 'the tenth call carries a reminder');
    assert.match(reminder!, /still applies/);
    assert.ok(!reminder!.includes('WHAT HAPPENS'), 'the reminder is one line, not the whole finding');
  } finally { await s.close(); }
});

/**
 * The autonomous writer trigger. A failed call is the corpus's own evidence
 * that something did not work, seen by a mechanism with no opinion at the
 * moment it happened: it goes to the ledger as a hole in THIS session, and
 * once per tool the result carries the invitation to record it.
 */
test('a failing call opens a hole in this session\'s ledger and invites a record, once', async () => {
  const home = corpus();
  const s = single(home);
  try {
    await s.init('t-client');
    const r1 = await s.call('mcp__data360__failing');
    assert.equal(r1.isError, true, 'the upstream\'s error flag must survive');
    assert.ok(texts(r1).some((x) => x.includes('mapping not found')), 'the upstream\'s error text must survive');
    assert.ok(texts(r1).some((x) => x.includes('cairn_record')), 'the first failure invites a record');
    const r2 = await s.call('mcp__data360__failing');
    assert.ok(!texts(r2).some((x) => x.includes('cairn_record')), 'the second failure does not nag');

    const dir = path.join(home, 'data', 'retrievals');
    const rows = fs.readdirSync(dir).flatMap((f) =>
      fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)),
    );
    const holes = rows.filter((r) => r.source === 'mcp-proxy:error');
    assert.equal(holes.length, 2, 'every failure is a hole, even when only the first is announced');
    assert.match(holes[0].session, /^proxy-/, 'the proxy is the session, so the hole is keyed to it');
    assert.deepEqual(holes[0].returned, [], 'a hole is a query nothing answered');
    // Attribution comes from initialize's clientInfo, which is the one place the client says who it is.
    assert.equal(holes[0].by, 't-client');
  } finally { await s.close(); }
});

/**
 * Wrapping a server that offers resources and prompts and forwarding only
 * its tools BREAKS that server, which is worse than not helping at all.
 */
test('resources and prompts pass through the proxy', async () => {
  const s = single(corpus());
  try {
    const init = await s.init();
    const caps = (init.result as { capabilities: Record<string, unknown> }).capabilities;
    assert.ok(caps.resources && caps.prompts, `capabilities must be the upstream's union: ${JSON.stringify(caps)}`);

    const list = await s.request('resources/list');
    assert.ok((list.result as { resources: { uri: string }[] }).resources.some((r) => r.uri === 'fixture://doc'));
    const read = await s.request('resources/read', { uri: 'fixture://doc' });
    const contents = (read.result as { contents: { text: string }[] }).contents;
    assert.ok(contents.some((c) => c.text.includes('resource body text from upstream')));

    const prompts = await s.request('prompts/list');
    assert.ok((prompts.result as { prompts: { name: string }[] }).prompts.some((p) => p.name === 'greet'));
    const got = await s.request('prompts/get', { name: 'greet', arguments: {} });
    const msgs = (got.result as { messages: { content: { text: string } }[] }).messages;
    assert.ok(msgs.some((m) => m.content.text.includes('prompt body text from upstream')));
  } finally { await s.close(); }
});

/**
 * One proxy per upstream is a configuration burden nobody will carry. With
 * several, names are prefixed so the client sees one list -- and the finding
 * still matches, because it was written against the WIRE name the person
 * saw, not the prefixed one the proxy invented.
 */
test('several upstreams share one tool list, and a finding still finds its tool', async () => {
  const home = corpus();
  const cfg = path.join(home, 'mcp.json');
  fs.writeFileSync(cfg, JSON.stringify({
    mcpServers: {
      alpha: { command: 'node', args: [FIXTURE, '--name', 'alpha'] },
      beta: { command: 'node', args: [FIXTURE, '--name', 'beta'] },
    },
  }));
  const s = new Session(home, ['--config', cfg]);
  try {
    const init = await s.init();
    const instructions = (init.result as { instructions?: string }).instructions ?? '';
    assert.match(instructions, /## alpha/);
    assert.match(instructions, /## beta/);

    const names = (await s.tools()).map((t) => t.name);
    assert.ok(names.includes('alpha__mcp__data360__query_records'));
    assert.ok(names.includes('beta__mcp__data360__query_records'));

    const r = await s.call('beta__mcp__data360__query_records', { object: 'A' });
    assert.ok(texts(r).some((x) => x.includes('cairn-0001')), 'the trigger names the wire name; the proxy must still match');

    const prompts = await s.request('prompts/list');
    const pnames = (prompts.result as { prompts: { name: string }[] }).prompts.map((p) => p.name);
    assert.ok(pnames.includes('alpha__greet') && pnames.includes('beta__greet'));
    const got = await s.request('prompts/get', { name: 'alpha__greet', arguments: {} });
    assert.ok(!got.error, 'a prefixed prompt must route to its owner');
  } finally { await s.close(); }
});

/**
 * A finding banked mid-session must reach the tool list before the next
 * decision, not the next session. The proxy fingerprints the corpus and
 * tells the client the list changed.
 */
test('a finding banked mid-session reaches the tool list and the client is told', async () => {
  const home = corpus();
  const s = single(home);
  try {
    await s.init();
    let tools = await s.tools();
    assert.equal(tools.find((t) => t.name === 'mcp__data360__unrelated')!.description, 'Something nothing is recorded about');

    bank(home, '0002-late.json', 'cairn-0002', 'banked mid-session: the unrelated tool drops the last page', 'mcp__data360__unrelated');
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !s.notifications.some((n) => n.method === 'notifications/tools/list_changed')) {
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(s.notifications.some((n) => n.method === 'notifications/tools/list_changed'), 'the client must be told the list changed');

    tools = await s.tools();
    assert.match(tools.find((t) => t.name === 'mcp__data360__unrelated')!.description!, /drops the last page/);
    const r = await s.call('mcp__data360__unrelated');
    assert.ok(texts(r).some((x) => x.includes('cairn-0002')), 'and the result carries it too');
  } finally { await s.close(); }
});

/**
 * An upstream that dies mid-call is an error RESULT, not a dead proxy, and
 * the call after it finds the upstream back. Degrade to something.
 */
test('a dead upstream is an error result, and it is respawned for the next call', async () => {
  const home = corpus();
  const marker = path.join(home, 'crashed');
  const s = new Session(home, ['--server', `node ${FIXTURE} --crash-marker ${marker}`]);
  try {
    await s.init();
    const r1 = await s.call('mcp__data360__unrelated');
    assert.equal(r1.isError, true);
    assert.ok(texts(r1).some((x) => x.includes('cairn-proxy')), 'the error names the proxy so nobody blames the tool');
    assert.ok(fs.existsSync(marker), 'the fixture really did exit');

    const r2 = await s.call('mcp__data360__unrelated');
    assert.ok(!r2.isError, 'one respawn, then the call succeeds');
    intactThenLabelled(r2, 'ok');
  } finally { await s.close(); }
});

/* ---------------------------------------------------------------------- */
/* The gateway: its own tools, the draft loop, and hosting                 */
/* ---------------------------------------------------------------------- */

const RECORDS = path.join(REPO, 'fixtures', 'mcp', 'records.mjs');

test('the gateway offers cairn_record, and a finding recorded through it reaches the next tools/list', async () => {
  const home = corpus(false);
  const s = single(home);
  try {
    await s.init();
    const before = await s.tools();
    assert.ok(before.some((t) => t.name === 'cairn_record'), 'cairn_record is offered');
    assert.ok(before.some((t) => t.name === 'cairn_find'), 'cairn_find is offered');
    assert.ok(!before.find((t) => t.name === 'mcp__data360__unrelated')!.description!.includes('from your Cairn corpus'), 'nothing recorded yet');
    const r = await s.call('cairn_record', {
      title: 'unrelated succeeds with ok and does nothing when the mapping is missing',
      claim: 'Calling the unrelated tool without a configured mapping returns ok and performs no work, so a caller cannot tell success from a silent no-op.',
      expectation: 'A call with nothing to act on fails or says so.',
      reality: 'It returns the string ok and nothing happens.',
      workaround: 'Check the mapping exists before calling it.',
      tool: 'mcp__data360__unrelated',
      evidence: [{ command: 'mcp__data360__unrelated {}', output: 'ok' }],
      check: {
        command: 'Call unrelated with no mapping configured and inspect whether any work was done.',
        confirmedIf: 'it returns ok and no work was done',
        refutedIf: 'it errors, or work was done',
      },
      by: 'test-agent',
    });
    assert.ok(!r.isError, texts(r).join('\n'));
    assert.match(texts(r).join('\n'), /Recorded cairn-0001/);
    assert.ok(fs.readdirSync(path.join(home, 'cairn')).some((f) => f.startsWith('0001-')), 'the file landed in the corpus home');
    const after = await s.tools();
    assert.match(after.find((t) => t.name === 'mcp__data360__unrelated')!.description!, /from your Cairn corpus.*cairn-0001/, 'the next listing carries it');
    const found = await s.call('cairn_find', { query: 'unrelated returns ok and does nothing when mapping missing' });
    assert.match(texts(found).join('\n'), /cairn-0001/, 'cairn_find sees it');
  } finally {
    await s.close();
  }
});

test('a refused record writes nothing and says why', async () => {
  const home = corpus(false);
  const s = single(home);
  try {
    await s.init();
    const r = await s.call('cairn_record', {
      title: 'a check that decides nothing',
      claim: 'This claim is long enough to parse but its check prints a verdict and exits zero either way.',
      expectation: 'x', reality: 'y',
      evidence: [{ command: 'true', output: '' }],
      check: { command: 'ls / ; echo checked', confirmedIf: 'prints checked', refutedIf: 'never' },
      by: 'test-agent',
    });
    assert.equal(r.isError, true);
    assert.match(texts(r).join('\n'), /cannot decide/);
    assert.equal(fs.readdirSync(path.join(home, 'cairn')).length, 0, 'nothing was written');
  } finally {
    await s.close();
  }
});

test('a failed call followed by a working one opens a draft on the result, once, and on disk', async () => {
  const home = corpus(false);
  const s = new Session(home, ['--server', `node ${RECORDS}`]);
  try {
    await s.init();
    const bad = await s.call('query_records', { object: 'Contact', filter: { nonsense: 'x' } });
    assert.equal(bad.isError, true, 'the bad filter errors upstream');
    const good = await s.call('query_records', { object: 'Contact', filter: { status: 'churned' }, limit: 2 });
    assert.ok(!good.isError);
    intactThenLabelled(good, good.content[0].text!);
    const note = texts(good).slice(1).join('\n');
    assert.match(note, /Earlier in this session query_records failed/, 'the draft names the hole');
    assert.match(note, /differed in: filter, limit/, 'it names what changed');
    assert.match(note, /"tool":"query_records"/, 'the draft carries the trigger');
    assert.match(note, /cairn_record/, 'and says how to record it');
    /* Dotfiles excluded: the directory writes its own .gitignore, so a CAIRN_HOME made by hand cannot commit drafts. */
    const drafts = fs.readdirSync(path.join(home, 'drafts')).filter((f) => !f.startsWith('.'));
    assert.equal(drafts.length, 1, 'one draft file');
    const draft = JSON.parse(fs.readFileSync(path.join(home, 'drafts', drafts[0]), 'utf8'));
    assert.equal(draft.evidence.length, 2);
    assert.match(draft.evidence[0].output, /unknown field nonsense/);
    /* A second recovery on the same tool is not a second draft. */
    const bad2 = await s.call('query_records', { object: 'Nope' });
    assert.equal(bad2.isError, true);
    const good2 = await s.call('query_records', { object: 'Contact', limit: 1 });
    assert.ok(!texts(good2).slice(1).join('\n').includes('Earlier in this session'), 'once per tool per session');
    const ledger = fs.readdirSync(path.join(home, 'data', 'retrievals')).flatMap((f) => fs.readFileSync(path.join(home, 'data', 'retrievals', f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { source: string }));
    assert.ok(ledger.some((r) => r.source === 'mcp-proxy:draft'), 'the draft is in the ledger');
    assert.ok(ledger.some((r) => r.source === 'mcp-proxy:call'), 'and so is every forwarded call');
    assert.equal(ledger.filter((r) => r.source === 'mcp-proxy:error').length, 2);
  } finally {
    await s.close();
  }
});

test('hosted over HTTP, two clients are two sessions: each gets its own first contact', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const home = corpus(true);
  const env: Record<string, string | undefined> = { ...process.env, CAIRN_HOME: home };
  delete env.CAIRN_SESSION;
  delete env.CAIRN_AGENT;
  const child = spawn('npx', ['tsx', 'scripts/mcp-proxy.ts', '--server', `node ${FIXTURE}`, '--http', '0'], {
    cwd: REPO, env: env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  const port = await new Promise<number>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`gateway did not announce a port\n${stderr}`)), 20_000);
    child.stderr!.on('data', (d) => {
      stderr += String(d);
      const m = /listening on http:\/\/[^:]+:(\d+)\/mcp/.exec(stderr);
      if (m) { clearTimeout(t); resolve(Number(m[1])); }
    });
  });
  try {
    const connect = async (name: string) => {
      const c = new Client({ name, version: '1' }, { capabilities: {} });
      await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
      return c;
    };
    const a = await connect('client-a');
    const b = await connect('client-b');
    assert.match(a.getInstructions() ?? '', /Tools with a recorded trap/, 'instructions carry the index');
    const ra = await a.callTool({ name: 'mcp__data360__query_records', arguments: { object: 'Lead' } });
    const rb = await b.callTool({ name: 'mcp__data360__query_records', arguments: { object: 'Lead' } });
    const noteA = (ra.content as Array<{ text?: string }>).slice(1).map((c) => c.text ?? '').join('\n');
    const noteB = (rb.content as Array<{ text?: string }>).slice(1).map((c) => c.text ?? '').join('\n');
    assert.match(noteA, /cairn-0001/, 'session A gets the full note');
    assert.match(noteB, /cairn-0001/, 'session B gets the full note too, not a shared once-per-process dedupe');
    const ra2 = await a.callTool({ name: 'mcp__data360__query_records', arguments: { object: 'Lead' } });
    assert.equal((ra2.content as unknown[]).length, 1, 'the second call in A is not annotated again');
    const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json() as { sessions: number };
    assert.equal(health.sessions, 2);
    const ledger = fs.readdirSync(path.join(home, 'data', 'retrievals')).flatMap((f) => fs.readFileSync(path.join(home, 'data', 'retrievals', f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { by: string; session: string; source: string }));
    const served = ledger.filter((r) => r.source === 'mcp-proxy:result');
    assert.equal(new Set(served.map((r) => r.session)).size, 2, 'two sessions in the ledger');
    assert.deepEqual(new Set(served.map((r) => r.by)), new Set(['client-a', 'client-b']), 'attributed to each client by name');
    await a.close();
    await b.close();
  } finally {
    child.kill('SIGKILL');
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
});

/* ------------------------------------------------------------------------ */
/* Degraded: the passenger must not crash the vehicle                        */
/* ------------------------------------------------------------------------ */

/**
 * A home that is not a corpus. This is the ordinary misconfiguration -- a
 * CAIRN_HOME left over from a move, a checkout that was never made -- and it
 * used to kill the proxy at require time, taking every upstream tool with it.
 * The client cannot tell Cairn from the server it asked for, so what it sees
 * is its own tools vanishing.
 */
function brokenHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-proxy-nohome-'));
}

test('a corpus it cannot reach costs the client nothing', async () => {
  const good = single(corpus(true));
  const bad = single(brokenHome());
  try {
    await good.init();
    await bad.init();

    /* Every upstream tool still there, and nothing of the gateway's own. */
    const upstreamTools = (await good.tools()).map((t) => t.name).filter((n) => !n.startsWith('cairn_'));
    const degradedTools = (await bad.tools()).map((t) => t.name);
    assert.deepEqual(degradedTools.sort(), upstreamTools.sort(), 'the upstream list, unchanged');
    assert.ok(!degradedTools.some((n) => n.startsWith('cairn_')), 'no tool is offered that cannot work');

    /* And the result is the upstream's, with nothing appended to it. */
    const r = await bad.call('query_records', { object: 'Contact' });
    assert.equal(r.content.length, 1, `nothing may be appended when there is no corpus: ${JSON.stringify(r.content)}`);

    assert.match(bad.stderr, /annotation disabled/, 'the operator is told once, where a client will not see it');
    assert.ok(!/Connection closed/.test(bad.stderr), 'and the process is still alive');
  } finally {
    await good.close();
    await bad.close();
  }
});

test('a broken corpus does not put Cairn in the instructions', async () => {
  const bad = single(brokenHome());
  try {
    const init = await bad.init();
    const instructions = (init.result as { instructions?: string }).instructions ?? '';
    assert.ok(
      !/Cairn/.test(instructions),
      `a ledger that is not there must not be described at connect: ${instructions.slice(0, 300)}`,
    );
  } finally {
    await bad.close();
  }
});
