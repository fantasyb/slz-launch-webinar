/**
 * cairn:gateway-smoke — put the gateway in front of a server nobody here wrote,
 * and prove it changed nothing it was not supposed to change.
 *
 *   npm run cairn:gateway-smoke                             # the everything server
 *   npm run cairn:gateway-smoke -- --server "npx -y @acme/their-mcp"
 *   npm run cairn:gateway-smoke -- --server "..." --call echo --args '{"message":"hi"}'
 *   npm run cairn:gateway-prove                             # + the DELIVERED arm, below, on the records fixture
 *   npm run cairn:gateway-smoke -- --server "..." --corpus <dir-with-cairn/> --name <client's name for it> --call <tool> --args '{...}'
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
 *
 * A FOURTH ARM, with --corpus: the install path, proven end to end.
 *
 *   delivered  through the gateway launched THE WAY A CLIENT CONFIG LAUNCHES
 *              IT (`cairn-proxy --config <mcp.json>`, the five-line block in
 *              GATEWAY.md under INSTALL), with a corpus that has a finding
 *              naming the tool that is called
 *
 * The three transparency arms prove the gateway adds nothing it should not;
 * this one proves it adds the one thing it should: the call returns the
 * upstream's result intact AND the finding rides behind it, labelled. Then
 * `cairn:report` is run against that arm's CAIRN_HOME and must list the tool
 * with the finding served -- the same report that says "recorded nothing yet"
 * on a corpus no session has gone through. That home is kept on disk and its
 * path printed, so the report can be re-run by hand against the same rows.
 * CAIRN_EVAL is deliberately NOT set on this arm: the ledger row IS the proof.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawnSync } from 'child_process';
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
/* The delivered arm: a directory with cairn/ in it (a CAIRN_HOME), and the name the client would give the server. */
const CORPUS = opt('corpus');
const NAME = opt('name', 'upstream')!;

/* A word the gateway prints on the surfaces it owns, so its additions are identifiable. */
const GATEWAY_TOOLS = ['cairn_find', 'cairn_record', 'cairn_note', 'cairn_observe'];
/* The sender label every block the gateway appends must carry (mcp-proxy.ts LABEL). */
const LABEL = 'from your Cairn corpus, not from this tool';

interface Probe {
  arm: string;
  tools: string[];
  /* name -> the parts of the definition a client acts on, so a dropped or
   * rewritten schema is visible. Names alone hid an outputSchema bug that
   * turned a working tool into a failing one: see cairn-0048. */
  defs: Record<string, string>;
  instructions: string;
  call: string | null;
  callError: string | null;
  /* The result's content blocks, as returned: the upstream's own first, the gateway's (labelled) after. */
  blocks: Array<{ type: string; text?: string }>;
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
/*
 * The delivered arm's home: a copy of the findings in --corpus, so the run
 * writes its ledger rows beside a corpus it owns and never into the one it was
 * pointed at. Kept after the run (the path is printed) so `cairn:report` can be
 * re-run against exactly these rows.
 */
function deliveredHome(corpus: string): string {
  const src = path.join(path.resolve(corpus), 'cairn');
  if (!fs.existsSync(src)) {
    console.log(`\nREFUSED — --corpus ${corpus} has no cairn/ directory in it.\n`);
    process.exit(2);
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-smoke-delivered-'));
  fs.mkdirSync(path.join(home, 'cairn'));
  for (const f of fs.readdirSync(src).filter((f) => f.endsWith('.json'))) fs.copyFileSync(path.join(src, f), path.join(home, 'cairn', f));
  return home;
}
/* Every finding id the corpus copy holds: one of them must be the one that rides on the result. */
function findingIds(home: string): string[] {
  const ids: string[] = [];
  for (const f of fs.readdirSync(path.join(home, 'cairn')).filter((f) => f.endsWith('.json'))) {
    try { ids.push(String((JSON.parse(fs.readFileSync(path.join(home, 'cairn', f), 'utf8')) as { id?: string }).id ?? '')); } catch { /* the gateway skips it too */ }
  }
  return ids.filter(Boolean);
}

function launch(arm: string, home: string | null) {
  const [cmd, ...args] = SERVER.split(/\s+/);
  let spec: { command: string; args: string[] };
  if (arm === 'direct') spec = { command: cmd, args };
  else if (arm === 'delivered') {
    /*
     * The install shape, exactly: the client's own {"mcpServers": {...}} in a
     * file, and the gateway launched with --config pointing at it. This is the
     * block GATEWAY.md tells a person to paste, so if it works here it works
     * from the documented steps alone.
     */
    const upstream = path.join(home!, 'upstream.json');
    fs.writeFileSync(upstream, `${JSON.stringify({ mcpServers: { [NAME]: { command: cmd, args } } }, null, 2)}\n`);
    spec = { command: 'node', args: [PROXY_BIN, '--config', upstream] };
  } else spec = { command: 'node', args: [PROXY_BIN, '--server', SERVER] };
  /*
   * CAIRN_EVAL so a smoke run does not land in the usage ledger as if
   * somebody had asked something. The ledger is evidence about demand; a
   * self-test writing into it is a self-fulfilling number. The delivered arm
   * is the one exception: its ledger row, in its own temporary home, is the
   * thing under test.
   */
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  delete env.CAIRN_EVAL;
  if (arm === 'delivered') {
    env.CAIRN_AGENT = 'gateway-smoke';
    env.CAIRN_SESSION = `smoke-delivered-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}`;
  } else {
    env.CAIRN_EVAL = '1';
    delete env.CAIRN_AGENT;
    delete env.CAIRN_SESSION;
  }
  if (home) env.CAIRN_HOME = home;
  else delete env.CAIRN_HOME;
  return { spec, env };
}

/** `cairn:report` against one home, as the operator would run it. */
function report(home: string): { out: string; status: number | null } {
  const r = spawnSync('npx', ['tsx', path.join(REPO, 'scripts', 'report.ts')], {
    cwd: REPO,
    /* Cast: this project augments ProcessEnv with a required NODE_ENV, which a copy with one variable added deliberately does not promise. */
    env: { ...process.env, CAIRN_HOME: home } as NodeJS.ProcessEnv,
    encoding: 'utf8',
  });
  return { out: `${r.stdout}${r.stderr}`, status: r.status };
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
  let blocks: Probe['blocks'] = [];
  if (listed.tools.some((t) => t.name === CALL)) {
    try {
      blocks = (await client.callTool({ name: CALL, arguments: CALL_ARGS })).content as Probe['blocks'];
      call = JSON.stringify(blocks);
    } catch (e) {
      callError = (e as Error).message;
    }
  }
  const out: Probe = {
    arm,
    tools: listed.tools.map((t) => t.name).sort(),
    defs: Object.fromEntries(
      listed.tools.map((t) => [
        t.name,
        JSON.stringify({ inputSchema: t.inputSchema, outputSchema: t.outputSchema ?? null }),
      ]),
    ),
    instructions: client.getInstructions() ?? '',
    call,
    callError,
    blocks,
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
  /*
   * Schemas, not just names. A tool's outputSchema changes what its own
   * client does with the result, and a relay that drops it -- or that acts on
   * it itself -- breaks a tool that works without the gateway.
   */
  const changed = Object.keys(direct.defs).filter((n) => seeded.defs[n] !== direct.defs[n]);
  must(changed.length === 0, 'input and output schemas survive unchanged', changed.join(', '));
  must(seeded.callError === null, `${CALL} did not error through the gateway`, seeded.callError ?? '');
  must(seeded.call === direct.call, `${CALL} returns identical content`);

  console.log('\n  DEGRADED — CAIRN_HOME wrong; the gateway must be undetectable');
  must(broken.tools.join() === direct.tools.join(), 'tool list identical to direct');
  must(JSON.stringify(broken.defs) === JSON.stringify(direct.defs), 'tool definitions identical to direct');
  must(broken.instructions === direct.instructions, 'instructions identical to direct');
  must(broken.call === direct.call, `${CALL} returns identical content`);
  must(
    /annotation disabled/.test(broken.stderr),
    'said why on stderr, where the operator can see it',
  );

  if (CORPUS) await proveDelivery(direct);

  console.log('\n' + '='.repeat(72));
  if (failures.length === 0) {
    console.log(CORPUS ? 'PASS — the gateway is transparent to this server, and it delivered.\n' : 'PASS — the gateway is transparent to this server.\n');
    return;
  }
  console.log(`FAIL — ${failures.length}:\n`);
  for (const f of failures) console.log('  ' + f);
  console.log(
    '\nA gateway that changes what the upstream offers is not a gateway, and one\n' +
      'that delivers nothing is not worth the hop. Fix this before pointing anything\n' +
      'expensive at this server.\n',
  );
  process.exitCode = 1;
}

/*
 * The delivered arm. What a crew member's session sees when their config is
 * routed through the gateway and a call trips a finding: the upstream's
 * result first and intact, the finding behind it, labelled -- and afterwards
 * the report that counts it. `direct` is the control for "intact".
 */
async function proveDelivery(direct: Probe): Promise<void> {
  const home = deliveredHome(CORPUS!);
  const ids = findingIds(home);
  console.log(`\n  DELIVERED — through \`cairn-proxy --config\` (the INSTALL shape), corpus of ${ids.length} finding(s)`);
  console.log(`             CAIRN_HOME=${home}   (kept; re-run the report against it by hand)`);
  const d = await probe('delivered', home);
  const lost = direct.tools.filter((t) => !d.tools.includes(t));
  const added = d.tools.filter((t) => !direct.tools.includes(t));
  must(lost.length === 0, 'every upstream tool survives, names untouched', lost.length ? `lost: ${lost.join(', ')}` : '');
  must(added.every((t) => GATEWAY_TOOLS.includes(t)), 'nothing added but the gateway\'s own', added.length ? `added: ${added.join(', ')}` : '');
  must(d.callError === null, `${CALL} did not error through the gateway`, d.callError ?? '');
  must(
    d.blocks.length > 0 && JSON.stringify(d.blocks[0]) === JSON.stringify(direct.blocks[0]),
    `${CALL}: the upstream's own result comes first and intact`,
  );
  const appended = d.blocks.slice(1).map((b) => b.text ?? '');
  must(appended.length > 0 && appended.every((t) => t.includes(LABEL)), 'every block behind it carries the sender label', appended.length ? '' : 'nothing was appended');
  const rode = ids.filter((id) => appended.some((t) => t.includes(id)));
  must(rode.length > 0, 'a finding naming this tool rides on the result', rode.length ? rode.join(', ') : `none of ${ids.join(', ')} appeared; check the finding's triggers name "${CALL}"`);
  if (rode.length) {
    /* The note as the model would read it, so the transcript carries what was delivered and not only that it was. */
    const note = appended.find((t) => ids.some((id) => t.includes(id)))!;
    console.log('\n  --- the result\'s second block, verbatim ---');
    for (const line of note.trimEnd().split('\n')) console.log(`  ${line}`);
    console.log('  --- end ---');
  }

  /* Now the number somebody carries into a meeting: does the report see it? */
  console.log('\n  REPORT — `CAIRN_HOME=<that home> npm run cairn:report`');
  const r = report(home);
  must(r.status === 0, 'cairn:report ran', r.status === 0 ? '' : `exit ${r.status}`);
  must(!/recorded nothing yet/.test(r.out), 'the report no longer says "recorded nothing yet"');
  const row = r.out.split('\n').find((l) => l.trim().startsWith(CALL.slice(0, 34)));
  must(!!row, `the report lists ${CALL}`, row ? row.trim() : 'no row for it');
  /* Row shape: tool  calls  errors  warned/called  findings  drafts  (surface n, ...). */
  const cols = (row ?? '').trim().split(/\s+/);
  must(Number(cols[4]) >= 1, 'with the served finding counted in its findings column', row ? `findings=${cols[4]}` : '');
  /* Every finding in the corpus that names the tool and has no `signature` rides, so the count is "at least one", not "one". */
  const onResult = /result (\d+)/.exec(row ?? '');
  must(!!onResult && Number(onResult[1]) >= 1, 'served on the result surface', onResult ? `result ${onResult[1]}` : 'no "(result n)" on the row');
  console.log('\n  --- cairn:report, verbatim ---');
  for (const line of r.out.trimEnd().split('\n')) console.log(`  ${line}`);
  console.log('  --- end ---');
}

void main().catch((e) => {
  console.error(`\ncairn:gateway-smoke: ${(e as Error).message}\n`);
  process.exit(1);
});
