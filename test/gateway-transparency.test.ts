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
  // The security-relevant fact is origin: 'agent' — the gateway declares that
  // what it records came from a model out of an untrusted tool, so the check is
  // never executed. (The author `by` is ownBy: the authenticated principal when
  // governed, the client name otherwise — attribution, not the safety property.)
  assert.match(proxy, /recordSubmission\(submission, \{ by: ownBy, origin: 'agent' \}\)/, 'the gateway declares itself');
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
 * A cheap message from an untrusted party must not amplify into unbounded work.
 * Two upstream-driven vectors are bounded: a tools/list_changed storm (each one
 * would otherwise drive a full re-list AND a client-notify fan-out), and a
 * spray of unknown tool names (each unknown name would otherwise drive a full
 * re-list across every upstream). This pins the structure that bounds them, so
 * a refactor that drops the debounce or the negative cache is caught.
 */
test('list_changed is coalesced and unknown tool names are negatively cached', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'scripts', 'mcp-proxy.ts'), 'utf8');

  // Debounce: a flush already queued for an (upstream, kind) drops the duplicate.
  assert.match(src, /const pendingListChanged = new Map/, 'there is a coalescing queue');
  assert.match(src, /if \(pendingListChanged\.has\(key\)\) return;/, 'a queued flush coalesces further notifications');
  // The three list_changed methods route through the debouncer and return,
  // rather than doing the expensive work inline per notification.
  for (const kind of ['tools', 'prompts', 'resources']) {
    assert.match(
      src,
      new RegExp(`notifications/${kind}/list_changed'\\)[^\\n]*scheduleListChangedFlush`),
      `${kind}/list_changed is debounced`,
    );
  }

  // Negative cache: an unknown name confirmed after a re-list is remembered, and
  // a subsequent call short-circuits BEFORE the re-list.
  assert.match(src, /const unknownToolCache = new Map/, 'the negative cache exists');
  assert.match(src, /if \(isKnownUnknownTool\(req\.params\.name\)\) \{[\s\S]{0,160}no upstream offers/, 'a cached-unknown name is refused before allTools()');
  assert.match(src, /rememberUnknownTool\(req\.params\.name\);/, 'a name still unknown after a re-list is cached');
  // And the cache is invalidated when the surface changes.
  assert.match(src, /toolOwner\.clear\(\); unknownToolCache\.clear\(\);/, 'a tools list_changed clears the negative cache');

  // Concurrent re-lists are deduped: a burst of distinct unknown names rides one
  // in-flight fan-out, not one per caller.
  assert.match(src, /let allToolsInFlight: Promise<Tool\[\]> \| null = null;/, 'there is a shared in-flight re-list');
  assert.match(src, /if \(allToolsInFlight\) return allToolsInFlight;/, 'concurrent callers share the one re-list');
});

/*
 * A tenant-authored (agentRecorded) finding is delivered only to its author, or
 * after an operator promotes it with a signed observation — the same gate the
 * checker uses before it will ever execute one. The risk is a governed,
 * multi-tenant gateway: principal A records a finding whose reality/workaround
 * text is theirs to write, and without this gate principal B is handed that
 * text as if the gateway vouched for it. Delivery is every path that puts
 * finding text in front of the model: the connect index, the tool-list
 * descriptions, cairn_find results, and the per-result annotation. The rot
 * detector at noteSurface is NOT delivery — it writes to operator stderr — so
 * it stays unfiltered, and this test pins that asymmetry: forget the filter at
 * one delivery site and a private finding leaks to every tenant.
 */
test('every model-delivery path filters findings through deliverableTo', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'scripts', 'mcp-proxy.ts'), 'utf8');

  // The gate exists and is the author/operator-promotion check, not a stub.
  assert.match(src, /function deliverableTo\(session: SessionState, findings: Finding\[\]\): Finding\[\]/, 'the gate is defined');
  const gate = src.slice(src.indexOf('function deliverableTo'), src.indexOf('function deliverableTo') + 600);
  assert.match(gate, /if \(!governed\(session\)\) return findings;/, 'ungoverned sessions are unaffected');
  assert.match(gate, /agentRecorded/, 'only tenant-authored findings are gated');
  assert.match(gate, /signature/, 'an operator-promoted (signed) finding is delivered');

  // Every model-delivery read of the corpus goes through the gate. If a new
  // delivery site is added it must too; if one is removed the count drops.
  const delivered = src.match(/deliverableTo\(session, localFindings\(\)\.findings\)/g) ?? [];
  assert.equal(delivered.length, 4, 'connect index, tool-list describe, cairn_find, and result annotate all filter');

  // The rot detector reads the corpus RAW: it is operator-facing stderr, never
  // handed to the model, and it must see every finding including other tenants'.
  const noteSurface = src.slice(src.indexOf('function noteSurface'), src.indexOf('function noteSurface') + 700);
  assert.match(noteSurface, /const findings = localFindings\(\)\.findings;/, 'rot detection stays unfiltered');
  assert.ok(!/deliverableTo/.test(noteSurface), 'the operator path is not gated by tenant delivery rules');
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
