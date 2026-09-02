/**
 * A library module must not resolve the corpus at import time.
 *
 * WHAT BROKE. Pointed at a third-party MCP server with CAIRN_HOME set to a
 * directory that was not a corpus, the gateway threw inside `require` --
 * before main(), before any handler, before any of its own error handling --
 * and the client's entire report was
 *
 *     McpError: MCP error -32000: Connection closed
 *
 * Thirteen working tools gone, and nothing in the message naming Cairn.
 *
 * The cause was a module-level `const KEYS_DIR = homePath('keys')`. homePath()
 * throws on a bad CAIRN_HOME on purpose, and for a CLI that is right: the user
 * ran a command that cannot work, and a silently ignored setting is worse. For
 * a library that a long-lived host imports it is fatal, because the throw
 * happens where the host has no stack to catch it on.
 *
 * WHY A LINT AND NOT A TEST OF BEHAVIOUR. Behaviour is tested too, over real
 * stdio, in proxy.test.ts. But there were EIGHT of these consts across five
 * files and only one of them had ever been noticed; the next one added will
 * not be noticed either, and it will present as a client-side connection
 * error in somebody else's terminal. The shape is the bug.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import os from 'os';

const LIB = path.join(process.cwd(), 'src', 'lib', 'cairn');

test('no module in src/lib/cairn calls homePath() at import time', () => {
  /*
   * Module scope, specifically. Inside a function body it is fine: the caller
   * has a stack. At the top level it runs during import, where the only
   * handler is the host's crash.
   */
  const offenders: string[] = [];
  for (const file of fs.readdirSync(LIB).filter((f) => f.endsWith('.ts'))) {
    fs.readFileSync(path.join(LIB, file), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (/^(export )?(const|let|var)\s+\w+\s*=\s*(homePath|cairnHome)\(/.test(line)) {
          offenders.push(`${file}:${i + 1}  ${line.trim()}`);
        }
      });
  }
  assert.deepEqual(
    offenders,
    [],
    'these run during import and can throw where no host can catch them:\n  ' + offenders.join('\n  '),
  );
});

/*
 * scripts/ is deliberately exempt: those files ARE the command, and a loud
 * throw at the top of one is the correct report to a person who set the
 * variable wrong. The rule is about being imported, not about being strict.
 */

/*
 * The gateway's record door must not be a shell reachable from upstream data.
 *
 * The workaround-delta gate runs `check.command` and `absentWhen` through
 * /bin/sh. That is a defensible thing to do for a person at a keyboard who
 * just wrote the command. It is a different thing entirely for a model
 * recording what it read out of a production tool's output, where the text
 * can be written by anyone who can write into the system being read. Machine
 * execution policy does not distinguish those two callers; `origin` does.
 */
test('a finding recorded through the gateway never has its check executed', async () => {
  const { recordSubmission } = await import('../src/lib/cairn/recordFinding');
  const src = fs.readFileSync(path.join(process.cwd(), 'src', 'lib', 'cairn', 'recordFinding.ts'), 'utf8');
  assert.match(
    src,
    /if \(opts\.origin === 'agent'\) \{/,
    'the agent branch must come before the policy branch, or policy can re-enable it',
  );
  const agentBranch = src.indexOf("opts.origin === 'agent'");
  const policyBranch = src.indexOf('policy.enabled && !policy.strict');
  assert.ok(agentBranch !== -1 && agentBranch < policyBranch, 'agent is checked first');

  const proxy = fs.readFileSync(path.join(process.cwd(), 'scripts', 'mcp-proxy.ts'), 'utf8');
  assert.match(proxy, /recordSubmission\(submission, \{ by: session\.agent, origin: 'agent' \}\)/, 'the gateway declares itself');
  assert.equal(typeof recordSubmission, 'function');
});

/*
 * The ledger is committed. What the gateway writes into it is therefore a
 * publishing decision, and it used to be "every argument of every forwarded
 * call, in full".
 */
test('a forwarded call is recorded by name and argument SHAPE, not by value', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'scripts', 'mcp-proxy.ts'), 'utf8');
  assert.match(src, /function callRecord\(/, 'there is one place that decides this');
  assert.ok(
    !/observe\(`\$\{req\.params\.name\} \$\{JSON\.stringify\(args\)\}`/.test(src),
    'the full-arguments form must not come back',
  );
  assert.match(src, /if \(process\.env\.CAIRN_RECORD_ARGS\) return/, 'values are opt-in, never the default');

  /* And the draft directory excludes itself wherever it is created. */
  assert.match(src, /fs\.writeFileSync\(ignore, '\*\\n'\)/, 'drafts/ carries its own .gitignore');
});

test('no ledger row can be unbounded, whatever the caller passes', () => {
  /*
   * In a CHILD process, because cairnHome() memoises on first use: setting
   * CAIRN_HOME from inside a test file whose other tests have already resolved
   * it does nothing, and the write lands in this repository's own committed
   * ledger instead of the temp directory the test thinks it is using. Which is
   * exactly what happened while writing this -- three junk rows in
   * data/retrievals/, from a test asserting that writes are bounded.
   */
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-ledger-cap-'));
  fs.mkdirSync(path.join(home, 'cairn'));
  const child = `
    const { record, readLedger } = require('${path.join(process.cwd(), 'src', 'lib', 'cairn', 'ledger.ts')}');
    record({ at: new Date().toISOString(), by: 'cap-test', session: 's',
             query: 'x'.repeat(500000), returned: [], source: 'test', outcomes: {} });
    const rows = readLedger().filter((r) => r.by === 'cap-test');
    console.log(JSON.stringify({ n: rows.length, len: rows[0] && rows[0].query.length, q: rows[0] && rows[0].query.slice(-40) }));
  `;
  const out = execFileSync('npx', ['tsx', '-e', child], {
    env: { ...process.env, CAIRN_HOME: home },
    encoding: 'utf8',
  });
  const got = JSON.parse(out.trim().split('\n').pop()!) as { n: number; len: number; q: string };
  assert.equal(got.n, 1, 'the row is still written');
  assert.ok(got.len < 3000, `a 500KB query became ${got.len} chars`);
  assert.match(got.q, /\[truncated \d+ chars\]/, 'and says it was cut, rather than lying about its length');
});

/*
 * The gateway must not apply the CLIENT's half of the tool contract.
 *
 * A tool that declares `outputSchema` and returns plain text is accepted by a
 * client that has not listed it and rejected by one that has -- that is the
 * SDK's rule, and it is the client's to apply. The proxy lists tools for
 * routing, which armed the same validator inside `callTool`, so it rejected
 * on the client's behalf and handed back an isError result the client never
 * asked it to produce:
 *
 *     direct    { content: [{ type: 'text', text: 'two' }] }
 *     gateway   isError, 'has an output schema but did not return structured
 *               content'
 *
 * A working tool, broken by being proxied. The fixture is raw JSON-RPC on
 * purpose: McpServer validates its own output, so an SDK-based fixture cannot
 * reproduce this at all.
 */
test('a tool that declares an output schema behaves the same through the gateway', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const FIXTURE = path.join(process.cwd(), 'fixtures', 'mcp', 'output-schema.mjs');

  /*
   * An empty corpus, so the comparison is of the relay and nothing else. With
   * this repository as the corpus the first result legitimately carries the
   * labelled index of program-triggered findings, which is delivery, not a
   * changed outcome; the invariant for that is intactThenLabelled in
   * proxy.test.ts.
   */
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-schema-probe-'));
  fs.mkdirSync(path.join(home, 'cairn'));
  async function call(viaGateway: boolean, listFirst: boolean): Promise<string> {
    const spec = viaGateway
      ? { command: 'node', args: [path.join(process.cwd(), 'bin', 'cairn-proxy.js'), '--server', `node ${FIXTURE}`] }
      : { command: 'node', args: [FIXTURE] };
    const client = new Client({ name: 'schema-probe', version: '0' }, { capabilities: {} });
    await client.connect(new StdioClientTransport({ ...spec, env: { ...process.env, CAIRN_EVAL: '1', CAIRN_HOME: home } as Record<string, string> }));
    try {
      if (listFirst) await client.listTools();
      const r = await client.callTool({ name: 'strict_textonly', arguments: { id: 'x' } });
      return `ok isError=${r.isError} ${JSON.stringify(r.content)}`;
    } catch (e) {
      return `threw ${(e as Error).message}`;
    } finally {
      await client.close();
    }
  }

  for (const listFirst of [false, true]) {
    const [direct, gateway] = [await call(false, listFirst), await call(true, listFirst)];
    assert.equal(gateway, direct, `listTools=${listFirst}: the gateway changed the outcome`);
  }
});
