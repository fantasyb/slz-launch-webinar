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
  assert.match(proxy, /recordSubmission\(args, \{ by: session\.agent, origin: 'agent' \}\)/, 'the gateway declares itself');
  assert.equal(typeof recordSubmission, 'function');
});
