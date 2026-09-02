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
  /** Resolves with the exit code when the proxy process ends. */
  exited: Promise<number | null>;

  constructor(home: string, args: string[], extraEnv: Record<string, string> = {}) {
    const env: Record<string, string | undefined> = { ...process.env, CAIRN_HOME: home, ...extraEnv };
    delete env.CAIRN_SESSION;
    delete env.CAIRN_AGENT;
    /* Cast: this project augments ProcessEnv with a required NODE_ENV, which
     * a copy with two variables deleted deliberately does not carry. */
    this.child = spawn('npx', ['tsx', 'scripts/mcp-proxy.ts', ...args], {
      cwd: REPO,
      env: env as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.exited = new Promise((r) => this.child.on('exit', (c) => r(c)));
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

  /** Send a request and return its id without waiting for a reply, for the calls that will be cancelled. */
  fire(method: string, params: unknown = {}): number {
    const id = this.next++;
    this.pending.set(id, () => undefined);
    this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return id;
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
    assert.match(instructions, /ledger of tool behaviour: what breaks, where, and what to do instead\. It is not memory/, 'says what it is and what it is not');
    assert.match(instructions, /where the check has been re-run, you can tell whether it is still true/, 'the advantage is conditional, not a promise');

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

/* ------------------------------------------------------------------------ */
/* The tool surface moving under the corpus                                  */
/* ------------------------------------------------------------------------ */

const MUTABLE = path.join(REPO, 'fixtures', 'mcp', 'mutable.mjs');

/**
 * Real servers add, rename and re-annotate tools while a session is open,
 * and the gateway is the one component positioned to see it. It notices,
 * records, and tells the model once on the next result -- and withholds
 * nothing: the new tool is listed, the renamed tool is routed, exactly as
 * the server offers them. A client asked for that server, not for this
 * gateway's opinion of it.
 */
test('a tool surface that changes mid-session is noticed, told once, recorded, and never enforced', async () => {
  const home = corpus(false);
  bank(home, '0001-q.json', 'cairn-0001', 'query_records caps at fifty rows silently', 'query_records', ['query_records limit']);
  const phase = path.join(home, 'phase');
  fs.writeFileSync(phase, 'base');
  const s = new Session(home, ['--server', `node ${MUTABLE} --phase-file ${phase}`]);
  try {
    await s.init();
    intactThenLabelled(await s.call('get_record', { object: 'Case', id: 'x' }), '{"status":"success","records":[]}');

    fs.writeFileSync(phase, 'destructive');
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !s.stderr.includes('delete_records appeared')) await new Promise((r) => setTimeout(r, 200));
    assert.match(s.stderr, /delete_records appeared \(declared destructive/, 'noticed by itself, from the server\'s own notification');
    assert.ok((await s.tools()).some((t) => t.name === 'delete_records'), 'the new tool is offered: nothing is withheld');

    const told = await s.call('get_record', { object: 'Case', id: 'x' });
    intactThenLabelled(told, '{"status":"success","records":[]}');
    const note = texts(told).slice(1).join('\n');
    assert.match(note, /tools changed while this session was open/);
    assert.match(note, /delete_records appeared/);
    const again = await s.call('get_record', { object: 'Case', id: 'x' });
    assert.equal(again.content.length, 1, 'told once, not on every result');

    fs.writeFileSync(phase, 'rename');
    const deadline2 = Date.now() + 8000;
    while (Date.now() < deadline2 && !s.stderr.includes('search_records')) await new Promise((r) => setTimeout(r, 200));
    assert.match(s.stderr, /query_records → search_records/, 'a rename is a rename, not a loss and a gain');
    assert.match(s.stderr, /cairn-0001 names query_records/, 'the finding that names the old name is pointed at');
    const routed = await s.call('search_records', { object: 'Case' });
    assert.equal(routed.isError, undefined, 'the renamed tool routes');
    const note2 = texts(routed).slice(1).join('\n');
    assert.match(note2, /query_records → search_records/);
    assert.match(note2, /cairn-0001/, 'the model is told which finding may no longer apply as written');

    const dir = path.join(home, 'data', 'retrievals');
    const rows = fs.readdirSync(dir).flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)));
    const kinds = rows.filter((r) => r.source.startsWith('mcp-proxy:surface-')).map((r) => r.source);
    assert.ok(kinds.includes('mcp-proxy:surface-appeared') && kinds.includes('mcp-proxy:surface-renamed'), `recorded for the report: ${kinds}`);
    const renamedRow = rows.find((r) => r.source === 'mcp-proxy:surface-renamed');
    assert.deepEqual(renamedRow.returned.map((h: { id: string }) => h.id), ['cairn-0001'], 'with the finding that names the tool');
  } finally { await s.close(); }
});

test('degraded, a changed tool surface is noticed on stderr and nothing is appended', async () => {
  const home = brokenHome();
  const phase = path.join(home, 'phase');
  fs.writeFileSync(phase, 'base');
  const s = new Session(home, ['--server', `node ${MUTABLE} --phase-file ${phase}`]);
  try {
    await s.init();
    await s.call('get_record', { object: 'Case', id: 'x' });
    fs.writeFileSync(phase, 'destructive');
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !s.stderr.includes('delete_records appeared')) await new Promise((r) => setTimeout(r, 200));
    assert.match(s.stderr, /delete_records appeared/);
    const r = await s.call('get_record', { object: 'Case', id: 'x' });
    assert.equal(r.content.length, 1, 'a gateway with no corpus must be indistinguishable from no gateway');
  } finally { await s.close(); }
});

/* ------------------------------------------------------------------------ */
/* Ambient, in front of a real connector all day                              */
/* ------------------------------------------------------------------------ */

/**
 * An upstream that does not start is a failure the client would have seen on
 * its own. Carrying on would present a connected server with the gateway's
 * two tools and none of the upstream's -- an empty vehicle that looks full.
 * The gateway exits instead, with the reason on stderr, which is exactly
 * what no gateway would have done.
 */
test('an upstream that cannot start takes the gateway down with it, visibly, rather than serving an empty list', async () => {
  const s = single(corpus());
  const bad = new Session(corpus(), ['--server', 'node /nonexistent/never-a-server.mjs']);
  try {
    const code = await Promise.race([bad.exited, new Promise<number | null>((r) => setTimeout(() => r(-1), 15_000))]);
    assert.equal(code, 1, `the proxy must exit, not serve; stderr:\n${bad.stderr}`);
    assert.match(bad.stderr, /did not start/);
    assert.match(bad.stderr, /exiting so the client sees the failure/);
    /* And a working one is unaffected by the rule. */
    await s.init();
    assert.ok((await s.tools()).some((t) => t.name === 'mcp__data360__query_records'));
  } finally { await s.close(); await bad.close(); }
});

/**
 * A restart that fails must not be the last one tried. Day-long sessions sit
 * in front of connectors whose tokens expire and are refreshed a minute
 * later; the gateway retries with backoff for as long as the session lasts,
 * and a call inside the wait says how long.
 */
test('a failed restart is retried with backoff, and the upstream comes back when it can', async () => {
  const home = corpus();
  const crash = path.join(home, 'crashed');
  const allow = path.join(home, 'allow-restart');
  fs.writeFileSync(allow, ''); /* present for the first start */
  const s = new Session(home, ['--server', `node ${FIXTURE} --crash-marker ${crash} --refuse-start-unless ${allow}`]);
  try {
    await s.init();
    fs.unlinkSync(allow); /* the restart will be refused until this is back */
    const r1 = await s.call('mcp__data360__unrelated');
    assert.equal(r1.isError, true, 'the fixture exits mid-call');
    const r2 = await s.call('mcp__data360__unrelated');
    assert.equal(r2.isError, true, 'the restart was refused');
    assert.match(texts(r2).join(''), /not running .*restart will be retried in \d+s|did not restart/, texts(r2).join(''));
    assert.match(s.stderr, /did not restart .*next attempt in 1s/);
    fs.writeFileSync(allow, '');
    await new Promise((r) => setTimeout(r, 1200));
    const r3 = await s.call('mcp__data360__unrelated');
    assert.ok(!r3.isError, `after the wait, the restart succeeds: ${texts(r3).join('')}`);
    intactThenLabelled(r3, 'ok');
    assert.match(s.stderr, /is back/);
  } finally { await s.close(); }
});

/**
 * The client's cancel reaches the upstream. Without it the proxy dropped the
 * response and the upstream ran the call to completion -- a write the person
 * cancelled, still written.
 */
test('a cancelled call is cancelled upstream, not merely unanswered', async () => {
  const home = corpus();
  const marker = path.join(home, 'slow-cancelled');
  const s = new Session(home, ['--server', `node ${FIXTURE} --slow-marker ${marker}`]);
  try {
    await s.init();
    const id = s.fire('tools/call', { name: 'mcp__data360__slow', arguments: {} });
    await new Promise((r) => setTimeout(r, 300));
    s.notify('notifications/cancelled', { requestId: id, reason: 'the person changed their mind' });
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !fs.existsSync(marker)) await new Promise((r) => setTimeout(r, 100));
    assert.ok(fs.existsSync(marker), 'the upstream\'s handler saw the abort within three seconds, not after its four-second run');
    /* The session is still healthy afterwards. */
    intactThenLabelled(await s.call('mcp__data360__unrelated'), 'ok');
  } finally { await s.close(); }
});

/* ------------------------------------------------------------------------ */
/* The other half: findings reached through a program, not a tool           */
/* ------------------------------------------------------------------------ */

/**
 * A finding whose trigger names a program has no tool for the gateway to
 * intercept. It reaches the model on the one push surface that is not
 * tool-specific -- the instructions at connect, and once on the first
 * result for clients that ignore instructions -- labelled, capped, coarse:
 * it names the program, not the moment.
 */
test('a finding triggered by a program, not a tool, is indexed at connect and on first contact', async () => {
  const home = corpus(false);
  bank(home, '0003-cli.json', 'cairn-0003', 'sf agent preview narrates the apex call instead of firing it when class access is missing', 'sf agent');
  bank(home, '0004-tool.json', 'cairn-0004', 'query_records caps at fifty', 'mcp__data360__query_records', ['sf data']);
  const s = single(home);
  try {
    const init = await s.init();
    const instructions = (init.result as { instructions?: string }).instructions ?? '';
    assert.match(instructions, /Programs with a recorded trap\. Coarse, on purpose/);
    assert.match(instructions, /- `sf agent`: "sf agent preview narrates .*" \(cairn-0003\)/);
    assert.ok(!/`sf data`/.test(instructions), 'a finding the tool index already carries is not repeated as a program');
    assert.match(instructions, /Tools with a recorded trap[\s\S]*cairn-0004/);

    const first = texts(await s.call('mcp__data360__unrelated'));
    const block = first.find((x) => x.includes('cairn-0003'));
    assert.ok(block, 'the first result carries it, for clients that ignore instructions');
    assert.match(block!, /not from this tool/);
    assert.match(block!, /`sf agent`/);
    const second = texts(await s.call('mcp__data360__unrelated'));
    assert.ok(!second.some((x) => x.includes('cairn-0003')), 'once');
    assert.deepEqual((await s.tools()).map((t) => t.name).filter((n) => n.startsWith('mcp__')).sort(),
      ['mcp__data360__failing', 'mcp__data360__query_records', 'mcp__data360__slow', 'mcp__data360__unrelated'], 'nothing withheld, nothing added');
  } finally { await s.close(); }
});

test('degraded, the program index says nothing', async () => {
  const bad = single(brokenHome());
  try {
    const init = await bad.init();
    const instructions = (init.result as { instructions?: string }).instructions ?? '';
    assert.ok(!/Programs with a recorded trap/.test(instructions));
    assert.ok(!/ledger of tool behaviour|It is not memory/.test(instructions), 'degraded says nothing, not even what it would have been');
  } finally { await bad.close(); }
});

/* ------------------------------------------------------------------------ */
/* The contradiction writer                                                  */
/* ------------------------------------------------------------------------ */

/**
 * cairn-0045: a writer keyed on errors is blind to the traps worth
 * recording. The gateway sees both halves of every call in a session, so it
 * can see the shape those traps do leave: an empty success, then a superset
 * of the arguments that returns rows. It offers a draft, once per tool, on
 * the result -- and writes nothing to the corpus.
 */
test('an empty success followed by a superset that returns rows offers a draft, once, and writes no finding', async () => {
  const home = corpus(false);
  const s = new Session(home, ['--server', `node ${RECORDS}`]);
  try {
    await s.init();
    /* Ordinary session first: a narrowing filter, a changed limit. Quiet. */
    intactThenLabelled(await s.call('query_records', { object: 'Contact', limit: 5 }), (await s.call('query_records', { object: 'Contact', limit: 5 })).content[0].text!);
    const narrowed = await s.call('query_records', { object: 'Contact', limit: 5, filter: { status: 'churned' } });
    assert.ok(!texts(narrowed).some((x) => x.includes('may contradict')), 'a narrowing filter is a different question');
    const bigger = await s.call('query_records', { object: 'Contact', limit: 50 });
    assert.ok(!texts(bigger).some((x) => x.includes('may contradict')), 'a changed limit is a different question');

    /* The stale mapping: nothing, then the same question through a fresh mapping. */
    const empty = await s.call('query_records', { object: 'Case', filter: { status: 'open' } });
    assert.ok(texts(empty)[0].includes('"records":[]'));
    const fresh = await s.call('query_records', { object: 'Case', filter: { status: 'open' }, mapping_id: 'mp_cases_v2' });
    intactThenLabelled(fresh, fresh.content[0].text!);
    const note = texts(fresh).slice(1).join('\n');
    assert.match(note, /Two calls to query_records in this session may contradict each other/);
    assert.match(note, /returned nothing; now, with mapping_id added, it returned 40 item\(s\)/);
    assert.match(note, /cairn_record/);
    assert.match(note, /"tool":"query_records"/, 'the draft carries the trigger');

    /* Once per tool. */
    const again = await s.call('query_records', { object: 'Case', filter: { status: 'open', queue: 'Tier2' } });
    const again2 = await s.call('query_records', { object: 'Case', filter: { status: 'open', queue: 'Tier2' }, mapping_id: 'mp_cases_v2' });
    assert.ok(!texts(again).concat(texts(again2)).some((x) => x.includes('may contradict')), 'a second contradiction on the same tool is not a second draft');

    /* Nothing in the corpus; a draft on disk; a ledger row. */
    assert.equal(fs.readdirSync(path.join(home, 'cairn')).length, 0, 'the gateway wrote no finding');
    const drafts = fs.readdirSync(path.join(home, 'drafts')).filter((f) => f.endsWith('-contradiction.json'));
    assert.equal(drafts.length, 1);
    const draft = JSON.parse(fs.readFileSync(path.join(home, 'drafts', drafts[0]), 'utf8'));
    assert.equal(draft.evidence.length, 2);
    assert.match(draft.evidence[0].note, /returned nothing/);
    const ledger = fs.readdirSync(path.join(home, 'data', 'retrievals')).flatMap((f) => fs.readFileSync(path.join(home, 'data', 'retrievals', f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { source: string }));
    assert.equal(ledger.filter((r) => r.source === 'mcp-proxy:contradiction').length, 1);
  } finally { await s.close(); }
});

/* ------------------------------------------------------------------------ */
/* The second tier: notes                                                    */
/* ------------------------------------------------------------------------ */

/**
 * One call, no thinking, kept outside the corpus, offered back once in a
 * later session on the first result from its tool, and closed by the
 * finding it becomes. The corpus's readers cannot see it in between.
 */
test('a note is one call, unreachable through the gateway, offered back by a later session, and closed by cairn_record', async () => {
  const home = corpus(false);
  const first = single(home);
  let noteId = '';
  try {
    await first.init();
    assert.ok((await first.tools()).some((t) => t.name === 'cairn_note'), 'cairn_note is offered beside cairn_record');
    const r = await first.call('cairn_note', {
      title: 'query_records returns nothing for Case with the default mapping',
      tool: 'mcp__data360__query_records',
      evidence: [{ command: 'query_records {"object":"Case"}', output: '{"status":"success","records":[]}' }],
      workaround: 'pass mapping_id explicitly',
    });
    assert.ok(!r.isError, texts(r).join('\n'));
    const m = /Noted \((note-[a-z0-9]+)\); not a finding until/.exec(texts(r)[0]);
    assert.ok(m, texts(r)[0]);
    noteId = m![1];
    assert.equal(fs.readdirSync(path.join(home, 'cairn')).length, 0, 'the corpus is untouched');

    /* Unreachable through every surface the gateway owns. */
    assert.match(texts(await first.call('cairn_find', { query: 'query_records returns nothing for Case default mapping' }))[0], /Nothing recorded/);
    const q = (await first.tools()).find((t) => t.name === 'mcp__data360__query_records')!;
    assert.equal(q.description, 'Query records', 'no index line, no description note');
    const same = await first.call('mcp__data360__query_records', { object: 'Case' });
    assert.ok(!texts(same).some((x) => x.includes('unfinished note')), 'the session that wrote it is not offered it back');
  } finally { await first.close(); }

  const later = single(home);
  try {
    await later.init();
    const r = await later.call('mcp__data360__query_records', { object: 'Case' });
    intactThenLabelled(r, '{"status":"success","records":[]}');
    const offer = texts(r).slice(1).join('\n');
    assert.match(offer, /You left an unfinished note about mcp__data360__query_records earlier today: "query_records returns nothing for Case with the default mapping"/);
    assert.match(offer, new RegExp(`passing note: "${noteId}"`));
    assert.match(offer, /the evidence is already in it/);
    const again = await later.call('mcp__data360__query_records', { object: 'Case' });
    assert.ok(!texts(again).some((x) => x.includes('unfinished note')), 'offered once per session');

    const rec = await later.call('cairn_record', {
      title: 'query_records returns an empty success for Case through the default mapping',
      claim: 'query_records on Case without mapping_id goes through a stale default mapping and returns success with no rows rather than an error.',
      expectation: 'A stale mapping fails loudly, or an empty result means no rows.',
      reality: 'It returns {"status":"success","records":[]} for every Case query through the default mapping.',
      workaround: 'Pass mapping_id explicitly.',
      tool: 'mcp__data360__query_records',
      evidence: [{ command: 'query_records {"object":"Case"}', output: '{"status":"success","records":[]}' }],
      check: { command: 'Query Case with no mapping_id and then with the freshest mapping; compare row counts.', confirmedIf: 'the default returns zero rows and the fresh mapping returns rows', refutedIf: 'the default returns rows' },
      note: noteId,
    });
    assert.ok(!rec.isError, texts(rec).join('\n'));
    assert.match(texts(rec)[0], new RegExp(`Finished note ${noteId}`));
    const drafts = fs.readdirSync(path.join(home, 'drafts')).filter((f) => f.startsWith('note-'));
    assert.equal(drafts.length, 1);
    const stored = JSON.parse(fs.readFileSync(path.join(home, 'drafts', drafts[0]), 'utf8'));
    assert.equal(stored.status, 'finished');
    assert.equal(stored.findingId, 'cairn-0001');
    assert.equal(fs.readdirSync(path.join(home, 'cairn')).length, 1, 'and now, through cairn_record, the corpus has it');
  } finally { await later.close(); }
});

/* ------------------------------------------------------------------------ */
/* Freshness on the surfaces, and the observation that keeps it real         */
/* ------------------------------------------------------------------------ */

test('a served finding says what its standing rests on and asks the agent to re-confirm; cairn_observe records the answer', async () => {
  const home = corpus(false);
  bank(home, '0001-old.json', 'cairn-0001', 'the query tool returns empty rather than erroring on a stale mapping', 'mcp__data360__query_records');
  /* Make its one observation twenty days old, by a person, on a manual check. */
  const file = path.join(home, 'cairn', '0001-old.json');
  const f = JSON.parse(fs.readFileSync(file, 'utf8'));
  f.observations = [{ by: 'joey.ahern', at: new Date(Date.now() - 20 * 86_400_000).toISOString(), verdict: 'confirmed', note: 'seen' }];
  f.check = { command: 'Look at it by hand.', confirmedIf: 'x', refutedIf: 'y', manual: true };
  fs.writeFileSync(file, JSON.stringify(f));
  const s = single(home);
  try {
    await s.init('t-client');
    const q = (await s.tools()).find((t) => t.name === 'mcp__data360__query_records')!;
    assert.match(q.description!, /\(cairn-0001, (fresh|aging|stale)\)/, 'the standing word rides on the description');
    const r = await s.call('mcp__data360__query_records', { object: 'A' });
    const note = texts(r).find((x) => x.includes('cairn-0001'))!;
    assert.match(note, /STANDING: (fresh|aging|stale) — attested by joey\.ahern 20 days ago, not by a check; check is manual: no machine can re-run it/);
    assert.match(note, /Not re-confirmed in 20 days\. If this call showed the trap still holds — or that it no longer does — say so: cairn_observe/);

    const bare = await s.call('cairn_observe', { finding: 'cairn-0001', verdict: 'refuted' });
    assert.equal(bare.isError, true, 'a refutation needs a note');
    const ok = await s.call('cairn_observe', { finding: 'cairn-0001', verdict: 'confirmed', note: 'returned zero rows again with the stale mapping' });
    assert.ok(!ok.isError, texts(ok).join('\n'));
    assert.match(texts(ok)[0], /Recorded confirmed on cairn-0001 by t-client; it now stands (fresh|aging)\. Unsigned, so it counts as one environment/);
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(stored.observations.length, 2);
    assert.equal(stored.observations[1].by, 't-client');
    assert.match(stored.observations[1].environment.note, /via cairn-proxy, client t-client/);
    const ledger = fs.readdirSync(path.join(home, 'data', 'retrievals')).flatMap((x) => fs.readFileSync(path.join(home, 'data', 'retrievals', x), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { source: string }));
    assert.ok(ledger.some((row) => row.source === 'mcp-proxy:observe-confirmed'));
  } finally { await s.close(); }
});

test('an arc the hook offered is answered through cairn_note: dismissed as a slip, or banked, and counted', async () => {
  const home = corpus(false);
  const arcsFile = path.join(home, 'arcs.jsonl');
  const { arcId } = await import('../src/lib/cairn/arcs');
  const failing = 'sf agent publish --nmae Demo';
  const arc = arcId('sf agent', failing);
  fs.writeFileSync(arcsFile, JSON.stringify({ at: new Date().toISOString(), arc, key: 'sf agent', failing, choice: 'offered' }) + '\n');
  const s = new Session(home, ['--server', `node ${FIXTURE}`], { CAIRN_ARCS: arcsFile });
  try {
    await s.init();
    const bad = await s.call('cairn_note', { dismiss: arc });
    assert.equal(bad.isError, true, 'dismiss needs `as`');
    const nope = await s.call('cairn_note', { dismiss: 'arc-00000000', as: 'my-mistake' });
    assert.equal(nope.isError, true, 'only an offered arc can be answered');
    const ok = await s.call('cairn_note', { dismiss: arc, as: 'my-mistake' });
    assert.ok(!ok.isError, texts(ok)[0]);
    assert.match(texts(ok)[0], /Dismissed arc-[0-9a-f]{8} as my-mistake; not offered again for a week/);
    const rows = fs.readFileSync(arcsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(rows.map((r) => r.choice), ['offered', 'my-mistake']);
    assert.equal(fs.readdirSync(path.join(home, 'cairn')).length, 0, 'a dismissal writes nothing anywhere else');
  } finally { await s.close(); }
});
