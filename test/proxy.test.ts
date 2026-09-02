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
    assert.deepEqual((await s.call('mcp__data360__unrelated')).content, [{ type: 'text', text: 'ok' }]);
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
    assert.deepEqual(r2.content, [{ type: 'text', text: 'ok' }], 'one respawn, then the call succeeds');
  } finally { await s.close(); }
});
