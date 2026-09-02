/**
 * cairn:gateway-smoke — put the gateway in front of a server nobody here wrote,
 * and prove it changed nothing it was not supposed to change.
 *
 *   npm run cairn:gateway-smoke                             # the everything server
 *   npm run cairn:gateway-smoke -- --server "npx -y @acme/their-mcp"
 *   npm run cairn:gateway-smoke -- --server "..." --call echo --args '{"message":"hi"}'
 *
 * No model, no API key, no cost. It speaks MCP directly and compares.
 *
 * WHY THIS EXISTS, and why it exists before the next experiment rather than
 * after it: every measurement in this repository so far ran the gateway
 * against fixtures/mcp/records.mjs, a server written here, wrapped by a
 * harness that seeds the corpus it points at. The first time the proxy was
 * pointed at a third-party server with an ordinary misconfiguration, it died
 * at require time and the client's entire report was
 *
 *     McpError: MCP error -32000: Connection closed
 *
 * Thirteen working tools, gone, and nothing in the message naming Cairn. The
 * harness could not have caught it. This can, in about a minute, and it is
 * the thing to run against a real server before anything expensive is
 * pointed at it.
 *
 * THE PROPERTY UNDER TEST is transparency, in three arms:
 *
 *   direct     the client talks to the upstream
 *   seeded     through the gateway, corpus present but empty
 *   degraded   through the gateway, CAIRN_HOME deliberately wrong
 *
 * `seeded` may add the gateway's own two tools and its instructions block;
 * everything of the upstream's must survive untouched. `degraded` must be
 * INDISTINGUISHABLE from `direct` -- same tools, same instructions, same
 * result bytes -- because a passenger that cannot do its job must not be
 * detectable by the client, let alone fatal to it.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

const REPO = process.cwd();
const PROXY_BIN = path.join(REPO, 'bin', 'cairn-proxy.js');

const argv = process.argv.slice(2);
function opt(name: string, dflt?: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : dflt;
}

const SERVER = opt('server', 'npx -y @modelcontextprotocol/server-everything')!;
const CALL = opt('call', 'echo')!;
const CALL_ARGS = JSON.parse(opt('args', '{"message":"cairn-smoke"}')!) as Record<string, unknown>;

/* A word the gateway prints on the surfaces it owns, so its additions are identifiable. */
const GATEWAY_TOOLS = ['cairn_find', 'cairn_record'];

interface Probe {
  arm: string;
  tools: string[];
  instructions: string;
  call: string | null;
  callError: string | null;
  stderr: string;
  ms: number;
}

/*
 * Two temp homes, both outside the repo: one that is a corpus (empty, so the
 * gateway has nothing to say) and one that is not (so it must give up). The
 * seeded one is empty on purpose -- a corpus with findings in it would make
 * "the gateway added nothing" untestable.
 */
function seededHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-smoke-ok-'));
  fs.mkdirSync(path.join(home, 'cairn'));
  return home;
}
function brokenHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-smoke-broken-'));
}

function launch(arm: string, home: string | null) {
  const [cmd, ...args] = SERVER.split(/\s+/);
  const spec =
    arm === 'direct'
      ? { command: cmd, args }
      : { command: 'node', args: [PROXY_BIN, '--server', SERVER] };
  /*
   * CAIRN_EVAL so a smoke run does not land in the usage ledger as if
   * somebody had asked something. The ledger is evidence about demand; a
   * self-test writing into it is a self-fulfilling number.
   */
  const env: Record<string, string> = { ...(process.env as Record<string, string>), CAIRN_EVAL: '1' };
  if (home) env.CAIRN_HOME = home;
  else delete env.CAIRN_HOME;
  return { spec, env };
}

async function probe(arm: string, home: string | null): Promise<Probe> {
  const started = Date.now();
  const { spec, env } = launch(arm, home);
  const transport = new StdioClientTransport({ ...spec, env, stderr: 'pipe' });
  const errs: string[] = [];
  const client = new Client({ name: 'cairn-smoke', version: '0' }, { capabilities: {} });
  await client.connect(transport);
  transport.stderr?.on('data', (d: Buffer) => errs.push(String(d)));
  const listed = await client.listTools();
  let call: string | null = null;
  let callError: string | null = null;
  if (listed.tools.some((t) => t.name === CALL)) {
    try {
      call = JSON.stringify((await client.callTool({ name: CALL, arguments: CALL_ARGS })).content);
    } catch (e) {
      callError = (e as Error).message;
    }
  }
  const out: Probe = {
    arm,
    tools: listed.tools.map((t) => t.name).sort(),
    instructions: client.getInstructions() ?? '',
    call,
    callError,
    stderr: errs.join(''),
    ms: Date.now() - started,
  };
  await client.close();
  return out;
}

const failures: string[] = [];
function must(ok: boolean, label: string, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

async function main() {
  console.log(`\nCAIRN GATEWAY SMOKE — upstream: ${SERVER}`);
  console.log('='.repeat(72));

  const direct = await probe('direct', null);
  console.log(`\n  direct: ${direct.tools.length} tools, ${direct.instructions.length} chars of instructions, ${direct.ms}ms`);
  if (!direct.tools.length) {
    console.log('\nREFUSED — the upstream offered no tools. Nothing here would mean anything.\n');
    process.exit(2);
  }

  const seeded = await probe('seeded', seededHome());
  const broken = await probe('degraded', brokenHome());

  console.log('\n  SEEDED — corpus present and empty; the gateway may add its own, and nothing else');
  const added = seeded.tools.filter((t) => !direct.tools.includes(t));
  const lost = direct.tools.filter((t) => !seeded.tools.includes(t));
  must(lost.length === 0, 'every upstream tool survives', lost.length ? `lost: ${lost.join(', ')}` : '');
  must(
    added.every((t) => GATEWAY_TOOLS.includes(t)),
    'nothing added but the gateway\'s own',
    added.length ? `added: ${added.join(', ')}` : '',
  );
  must(
    seeded.instructions.startsWith(direct.instructions),
    'upstream instructions kept verbatim, and first',
  );
  must(seeded.callError === null, `${CALL} did not error through the gateway`, seeded.callError ?? '');
  must(seeded.call === direct.call, `${CALL} returns identical content`);

  console.log('\n  DEGRADED — CAIRN_HOME wrong; the gateway must be undetectable');
  must(broken.tools.join() === direct.tools.join(), 'tool list identical to direct');
  must(broken.instructions === direct.instructions, 'instructions identical to direct');
  must(broken.call === direct.call, `${CALL} returns identical content`);
  must(
    /annotation disabled/.test(broken.stderr),
    'said why on stderr, where the operator can see it',
  );

  console.log('\n' + '='.repeat(72));
  if (failures.length === 0) {
    console.log('PASS — the gateway is transparent to this server.\n');
    return;
  }
  console.log(`FAIL — ${failures.length}:\n`);
  for (const f of failures) console.log('  ' + f);
  console.log(
    '\nA gateway that changes what the upstream offers is not a gateway. Fix this\n' +
      'before pointing anything expensive at this server.\n',
  );
  process.exitCode = 1;
}

void main().catch((e) => {
  console.error(`\ncairn:gateway-smoke: ${(e as Error).message}\n`);
  process.exit(1);
});
