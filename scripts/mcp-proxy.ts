/**
 * Cairn as a gateway: findings ride back on the results they are about, and
 * ride ahead on the descriptions of the tools they are about.
 *
 *   node bin/cairn-proxy.js --server "npx -y @acme/their-mcp-server"
 *   node bin/cairn-proxy.js --server data360="..." --server slack="..."
 *   node bin/cairn-proxy.js --config ~/.cursor/mcp.json     # any client's mcpServers map
 *
 * Point your client at this instead of at the servers it wraps. Every request
 * is forwarded and every result is returned; the proxy only ever ADDS text,
 * and it labels what it adds.
 *
 * WHY A RESULT AND NOT A HOOK. Push delivery is the binding constraint --
 * cairn-0035 measured that an agent which does not ask gets nothing, and a
 * weak model went 0/5 to 4/5 on the same corpus when findings were handed
 * over unasked. MCP tools are PULL, and a client hook is real push that
 * belongs to one vendor. Two things reach the model in every client with no
 * feature to negotiate: a tool's RESULT, which it always reads, and a tool's
 * DESCRIPTION, which it reads before deciding to call. This uses both.
 *
 *   after the call   the finding travels on the result it is about
 *   before the call  one labelled line on the tool's description
 *
 * The description line is the universal before-the-call channel and it is
 * coarse on purpose: it names the trap, it does not explain it, and the
 * explanation arrives on the result. Descriptions are paid for on every turn,
 * so the budget is one line per tool and a cap on the total.
 *
 * NEVER A GATE. Every request is forwarded and every result returned,
 * including when the corpus is unreadable and when this file throws. A
 * mechanism that can block a call is one people switch off.
 *
 * WHAT IS LEFT OUT, said here rather than discovered: progress notifications
 * for long tool calls are not relayed (the SDK's 60s default timeout IS lifted,
 * which is the part that breaks a long call), and the sampling/elicitation
 * requests an upstream might make of its client are not proxied back. Both
 * are rare in the servers this is being built for and both are additive later.
 */
import fs from 'fs';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  CompleteRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  LoggingMessageNotificationSchema,
  PromptListChangedNotificationSchema,
  ReadResourceRequestSchema,
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
  SetLevelRequestSchema,
  SubscribeRequestSchema,
  ToolListChangedNotificationSchema,
  UnsubscribeRequestSchema,
  type ServerCapabilities,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import http from 'http';
import { randomUUID } from 'crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { preflight, retrieve } from '../src/lib/cairn/retrieval';
import { FindingSchema, type Finding } from '../src/lib/cairn/schema';
import { homePath } from '../src/lib/cairn/home';
import { observe } from '../src/lib/cairn/observe';
import { recordSubmission } from '../src/lib/cairn/recordFinding';
import { redactForLedger } from '../src/lib/cairn/safety';

/* ------------------------------------------------------------------------ */
/* Configuration                                                             */
/* ------------------------------------------------------------------------ */

interface UpstreamSpec {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

function usage(): never {
  console.error(
    'usage: cairn-proxy --server "<command>"            one upstream, names untouched\n' +
      '       cairn-proxy --server name="<command>" ...   several; tools become name__tool\n' +
      '       cairn-proxy --config <mcp.json>              a client\'s {"mcpServers": {...}}\n' +
      '       ... --http <port>                            serve over Streamable HTTP at /mcp instead of stdio',
  );
  process.exit(2);
}

/** Port for the hosted mode, or null for stdio. */
let HTTP_PORT: number | null = null;

function parseArgs(argv: string[]): UpstreamSpec[] {
  const specs: UpstreamSpec[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--http') {
      const v = argv[++i];
      if (v === undefined || !/^\d+$/.test(v)) usage();
      HTTP_PORT = Number(v);
    } else if (argv[i] === '--server') {
      const v = argv[++i];
      if (!v) usage();
      const m = /^([A-Za-z0-9_-]+)=(.+)$/.exec(v);
      const name = m ? m[1] : `upstream${specs.length + 1}`;
      const [command, ...args] = (m ? m[2] : v).trim().split(/\s+/);
      specs.push({ name, command, args });
    } else if (argv[i] === '--config') {
      const file = argv[++i];
      if (!file) usage();
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
        servers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
      };
      for (const [name, s] of Object.entries(raw.mcpServers ?? raw.servers ?? {})) {
        if (!s?.command) continue;
        specs.push({ name, command: s.command, args: s.args ?? [], env: s.env });
      }
    }
  }
  if (!specs.length) usage();
  return specs;
}

/* ------------------------------------------------------------------------ */
/* The corpus, local only, cached by content                                 */
/* ------------------------------------------------------------------------ */

/*
 * Only LOCAL findings annotate. A finding from a corpus somebody else
 * maintains, injected into a result the model trusts, is a different trust
 * decision from reading it in a search, and it is the org's to make. That
 * makes loadSearchable unnecessary here, and it sidesteps loadCorpus(), which
 * memoises for the life of the process -- correct for a CLI that lives 90ms,
 * wrong for a proxy that lives a session and must see a finding banked five
 * minutes ago.
 *
 * Invalidated by fingerprint rather than by time: the names, sizes and mtimes
 * of every file in cairn/. Cheap enough to check on every request, and it is
 * what lets the tool list say "changed" only when something did.
 */
let corpusMemo: { fingerprint: string; findings: Finding[] } = { fingerprint: '', findings: [] };

/*
 * THE PASSENGER MUST NOT CRASH THE VEHICLE.
 *
 * Everything below this line is Cairn's own business. The client's business
 * is the upstream server, and it asked for that server -- the gateway is
 * something it agreed to have in the middle, not something it wants to hear
 * from when Cairn is misconfigured.
 *
 * The first run of this proxy against a server nobody here wrote died before
 * main(): CAIRN_HOME pointed at a directory with no cairn/ in it, homePath()
 * threw at require time, and the client's entire report was
 *
 *     McpError: MCP error -32000: Connection closed
 *
 * -- every tool the upstream offered, gone, with nothing in the message
 * naming Cairn. Our own trial harness could never see it, because the
 * harness seeds the corpus it points at.
 *
 * So the corpus is resolved through here, once, and a failure latches: the
 * reason is written to stderr a single time and every annotation path
 * afterwards is a no-op. A gateway that cannot annotate is a gateway that
 * forwards, which is exactly what the client wanted in the first place.
 */
let degradedReason: string | null = null;
function corpusDir(): string | null {
  if (degradedReason) return null;
  try {
    return homePath('cairn');
  } catch (e) {
    degradedReason = (e as Error).message;
    process.stderr.write(
      `cairn-proxy: annotation disabled -- ${degradedReason}\n` +
        'cairn-proxy: traffic is being forwarded untouched.\n',
    );
    return null;
  }
}

/** Whether this process gave up on its corpus, and why. Reported, never thrown. */
export function degraded(): string | null {
  return degradedReason;
}

function corpusFingerprint(): string {
  const dir = corpusDir();
  if (!dir) return '';
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return `${f}:${st.size}:${st.mtimeMs}`;
      })
      .join('|');
  } catch {
    return '';
  }
}

/** Active local findings. A file that does not parse is skipped, never fatal. */
function localFindings(): { findings: Finding[]; changed: boolean } {
  const fingerprint = corpusFingerprint();
  if (fingerprint === corpusMemo.fingerprint) return { findings: corpusMemo.findings, changed: false };
  const dir = corpusDir();
  if (!dir) return { findings: [], changed: false };
  const findings: Finding[] = [];
  try {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
      try {
        const parsed = FindingSchema.safeParse(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
        if (parsed.success && parsed.data.status === 'active') findings.push(parsed.data);
      } catch {
        /* one bad file must not silence the rest */
      }
    }
  } catch {
    /* no corpus directory: nothing to annotate with */
  }
  corpusMemo = { fingerprint, findings };
  return { findings, changed: true };
}

/* ------------------------------------------------------------------------ */
/* Matching a tool to the findings about it                                  */
/* ------------------------------------------------------------------------ */

/**
 * Every name the same tool goes by.
 *
 * The proxy sees the WIRE name (`query_records`). A Claude Code hook sees the
 * client's name for it (`mcp__data360__query_records`). A person banking a
 * finding uses whichever they were looking at, so a trigger written against
 * one never matched the other -- the hook and the proxy each delivered half
 * the corpus. Preflight is run against all of them and the results unioned.
 */
function namesFor(upstream: string, raw: string, exposed: string): string[] {
  return [...new Set([raw, exposed, `mcp__${upstream}__${raw}`, `mcp__${upstream}__${exposed}`])];
}

/** A finding about a tool, and the arguments of that tool it names, if any. */
interface About {
  finding: Finding;
  /** Argument names from triggers of the form `<tool> <argument>`. Empty means the whole tool. */
  props: string[];
}

/**
 * THE ARGUMENT CHANNEL. A trigger may name an argument as well as a tool:
 * `mcp__data360__query_records mapping_id`. Such a finding is about that
 * argument, so it is delivered where the model is choosing it -- on the
 * argument's own schema description, which every client sends to the model
 * because that is how function calling works -- and on the result only when
 * that argument was actually supplied. Pre-call AND argument-aware, at zero
 * latency, and the client cannot fail to pass it because it is the schema.
 *
 * Matched here rather than through preflight, whose two-word form is for
 * shell subcommands and refuses an underscore in the second word.
 */
function findingsAbout(upstream: string, raw: string, exposed: string, findings: Finding[], properties: string[] = []): About[] {
  const names = new Set(namesFor(upstream, raw, exposed).map((n) => n.toLowerCase()));
  const byId = new Map<string, About>();
  for (const name of names) {
    let warnings;
    try {
      warnings = preflight(name, findings, { useLocalEnvironment: true });
    } catch {
      continue; /* a corpus problem never reaches the caller */
    }
    for (const w of warnings) if (!byId.has(w.finding.id)) byId.set(w.finding.id, { finding: w.finding, props: [] });
  }
  const propSet = new Set(properties);
  for (const f of findings) {
    if (f.status !== 'active') continue;
    for (const t of f.triggers ?? []) {
      const [tool, prop, extra] = t.trim().split(/\s+/);
      if (!prop || extra || !names.has(tool.toLowerCase()) || !propSet.has(prop)) continue;
      const a = byId.get(f.id) ?? { finding: f, props: [] };
      if (!a.props.includes(prop)) a.props.push(prop);
      byId.set(f.id, a);
    }
  }
  return [...byId.values()];
}

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * The label is load-bearing rather than decorative. A model implicitly trusts
 * a tool result and reads a tool description before deciding anything, and
 * this appends text to both -- so it has to be unmistakable that the added
 * block came from the user's own corpus and not from the service. Every push
 * channel is prompt injection with a trusted sender; the delimiter is what
 * keeps the sender honest.
 */
const LABEL = 'from your Cairn corpus, not from this tool';

function fullNote(f: Finding): string {
  return (
    `\n\n--- ${LABEL} ---\n` +
    `${f.id} — ${f.title}\n` +
    `WHAT HAPPENS: ${clip(f.reality, 400)}` +
    (f.workaround ? `\nINSTEAD: ${clip(f.workaround, 400)}` : '') +
    `\n--- end ---`
  );
}

function reminderNote(f: Finding): string {
  return `\n\n--- ${LABEL} --- ${f.id} still applies to this tool: ${clip(f.title, 100)} --- end ---`;
}

function bankNudge(): string {
  return (
    `\n\n--- ${LABEL} ---\n` +
    'Nothing is recorded about this failure. If you work it out, record it with cairn_record ' +
    'while you still remember what you expected.\n--- end ---'
  );
}

/**
 * Descriptions are read every turn, so this is one line, and one title.
 *
 * The full finding is NOT put here. A description that explains the trap
 * costs its explanation on every turn of every session whether or not the
 * tool is called; a description that names it costs a line, and the
 * explanation arrives on the result if the call is made. Above the cap the
 * remaining tools get a count only, so a corpus of two hundred findings cannot
 * turn the tool list into a wall.
 */
const DESCRIPTION_CAP = 12;
/** Argument notes per tool. Two arguments with traps is a tool worth reading about; five is a wall. */
const ARGUMENT_CAP = 2;

type Props = Record<string, { description?: string } & Record<string, unknown>>;

function propertyNames(tool: Tool): string[] {
  const props = (tool.inputSchema as { properties?: Props } | undefined)?.properties;
  return props ? Object.keys(props) : [];
}

function describe(session: SessionState, tool: Tool, about: About[], budgetLeft: number): Tool {
  if (!about.length) return tool;
  for (const a of about) served(session, a.finding.id, tool.name, a.props.length ? 'argument' : 'description');
  const out: Tool = { ...tool, inputSchema: { ...tool.inputSchema } };
  const props = (out.inputSchema as { properties?: Props }).properties;

  /*
   * An argument-level finding goes on the argument, not on the tool: it is
   * read at the moment the model is choosing that value, which is as precise
   * as pre-call gets. The label rides inside the description string, because
   * a JSON Schema has no other place for provenance and a model reads the
   * string whole.
   */
  let argumentNotes = 0;
  const onTool: About[] = [];
  for (const a of about) {
    let placed = false;
    for (const prop of a.props) {
      if (!props?.[prop] || argumentNotes >= ARGUMENT_CAP) continue;
      const line = `[${LABEL}: ${clip(a.finding.title, 110)} (${a.finding.id}). Details arrive on the result.]`;
      const prev = props[prop].description ?? '';
      props[prop] = { ...props[prop], description: prev ? `${prev} ${line}` : line };
      argumentNotes++;
      placed = true;
    }
    if (!placed) onTool.push(a);
  }
  if (props) (out.inputSchema as { properties?: Props }).properties = { ...props };

  if (onTool.length) {
    const base = tool.description ?? '';
    const n = onTool.length;
    const line =
      budgetLeft > 0
        ? `[${LABEL}: ${n} recorded trap${n === 1 ? '' : 's'} — "${clip(onTool[0].finding.title, 110)}" (${onTool[0].finding.id}). Details arrive on the result.]`
        : `[${LABEL}: ${n} recorded trap${n === 1 ? '' : 's'}. Details arrive on the result.]`;
    out.description = base ? `${base}\n\n${line}` : line;
  }
  return out;
}

/* ------------------------------------------------------------------------ */
/* Per-session delivery policy                                               */
/* ------------------------------------------------------------------------ */

/*
 * The same finding on every call to the same tool is the failure the brief
 * was designed against: the reader learns that the trailing block is
 * wallpaper and stops reading it. So the full note is delivered once per
 * (tool, finding) per session, a one-line reminder every REMIND_EVERY calls
 * after that, and nothing in between. Compaction can drop the first note from
 * a long session; the reminder is what survives that.
 */
const REMIND_EVERY = 10;

/**
 * Everything that is "once per session" lives here, and nowhere else.
 *
 * Over stdio one process is one session, and module-level sets were enough.
 * Hosted, one process serves every client that connects, and a set shared
 * between them means the second client never receives the note the first
 * one already saw. That is the kind of bug that looks like delivery working
 * -- the ledger shows the note served -- while half the sessions got nothing.
 */
interface SessionState {
  id: string;
  /** The client's own name from initialize, for attribution. */
  agent?: string;
  /** Upstreams whose trap index has already been delivered on a result. */
  introduced: Set<string>;
  callsByTool: Map<string, number>;
  /** `${tool}|${findingId}` pairs whose full note has been delivered. */
  shown: Set<string>;
  /** Tools that have carried the record-this invitation. */
  nudged: Set<string>;
  /** The last failed call per tool: the open holes. */
  holes: Map<string, { args: Record<string, unknown>; output: string; at: string }>;
  /** Tools for which a draft has already been opened this session. */
  drafted: Set<string>;
}

function newSession(id: string): SessionState {
  return {
    id, introduced: new Set(), callsByTool: new Map(), shown: new Set(), nudged: new Set(), holes: new Map(), drafted: new Set(),
  };
}

/**
 * Write down what was actually delivered, and on which surface.
 *
 * Without this the product's only delivery path leaves no trace. The proxy
 * observed errors and nothing else, so every annotation it put on a tool
 * description, an argument schema or a result went to the model and vanished
 * — and after a pilot the only thing that would ever have seen one is
 * `test/proxy.test.ts`.
 *
 * That is the failure this repository already shipped once and fixed at
 * d36bc81, where 240 of 273 ledger rows turned out to be the eval suite and
 * `cairn:status` was reporting the test harness as adoption. The same mistake
 * in a new costume: an instrument that records only what it was built to
 * record, and a delivery mechanism nobody can audit afterwards.
 *
 * Tagged `mcp-proxy:*` and never `cli:find`, so served annotations can never
 * be mistaken for somebody asking a question.
 */
function served(session: SessionState, findingId: string, tool: string, surface: string): void {
  try {
    observe(
      `${tool} [${surface}]`,
      [{ finding: { id: findingId }, rank: 1, strength: 'strong' }] as never,
      `mcp-proxy:${surface}`,
      { by: session.agent, session: session.id },
    );
  } catch (e) {
    /*
     * Delivery must never fail because the ledger could not be written — but
     * a silent catch here hid the fact that this function recorded nothing at
     * all, which is the exact defect it was added to fix. Loud on stderr,
     * which the client shows as server noise and never feeds to the model.
     */
    process.stderr.write(`cairn-proxy: could not record delivery: ${(e as Error).message}\n`);
  }
}

function annotate(session: SessionState, exposed: string, about: About[], isError: boolean, args: Record<string, unknown>): string {
  const { callsByTool, shown, nudged } = session;
  const calls = (callsByTool.get(exposed) ?? 0) + 1;
  callsByTool.set(exposed, calls);
  let out = '';
  const relevant = about.filter(
    (a) => !a.props.length || a.props.some((p) => args[p] !== undefined && args[p] !== null && args[p] !== ''),
  );
  for (const { finding: f } of relevant) {
    const key = `${exposed}|${f.id}`;
    if (!shown.has(key)) {
      shown.add(key);
      out += fullNote(f);
      served(session, f.id, exposed, 'result');
    } else if (calls % REMIND_EVERY === 0) {
      out += reminderNote(f);
      served(session, f.id, exposed, 'result-reminder');
    }
  }
  /*
   * THE AUTONOMOUS WRITER TRIGGER. "Bank that" needs a person to say it. A
   * failed call is the corpus's own evidence that something did not work,
   * seen here by a mechanism with no opinion, at the moment it happened. It
   * goes to the ledger as a hole in this session, and -- once per tool -- the
   * result carries the invitation to record it. Only for errors: an empty
   * result is legitimate for most tools most of the time, and a nudge on
   * every empty result is noise.
   */
  if (isError && !relevant.length && !nudged.has(exposed)) {
    nudged.add(exposed);
    out += bankNudge();
  }
  return out;
}

/* ------------------------------------------------------------------------ */
/* The hole-to-draft loop                                                    */
/* ------------------------------------------------------------------------ */

/*
 * "Bank that" needs a person to notice. The gateway can notice one shape by
 * itself, with no opinion: a call to a tool failed, and a later call to the
 * same tool in the same session worked. Something changed between them, the
 * agent knows what, and it is the exact moment cairn-0034 says the knowledge
 * is cheapest -- the trap has just been made to go away.
 *
 * So the working result carries a draft: the failing call and its output as
 * evidence, the arguments that differed, the tool as the trigger, and a
 * prose check. What it cannot supply is what only the writer knows --
 * expectation, reality, absentWhen -- and it asks for exactly those. The
 * draft is also written under drafts/ in the corpus home, so a session that
 * ends without recording leaves the hole visible to a person.
 *
 * Once per tool per session. A tool that fails and recovers ten times is one
 * trap, not ten, and the tenth draft is wallpaper.
 */
function argDiff(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

function draftFor(session: SessionState, tool: string, args: Record<string, unknown>): string {
  const hole = session.holes.get(tool);
  if (!hole || session.drafted.has(tool)) return '';
  session.drafted.add(tool);
  session.holes.delete(tool);
  const differed = argDiff(hole.args, args);
  const draft = {
    tool,
    title: '',
    claim: '',
    expectation: '',
    reality: '',
    workaround: differed.length ? `Differed in: ${differed.join(', ')}` : '',
    evidence: [
      { command: `${tool} ${JSON.stringify(hole.args)}`, output: hole.output.slice(0, 2000) },
      { command: `${tool} ${JSON.stringify(args)}`, output: '(succeeded)' },
    ],
    check: {
      command: `Call ${tool} with the failing arguments and confirm the error, then with the working ones and confirm success.`,
      confirmedIf: 'the first call fails as recorded and the second succeeds',
      refutedIf: 'the first call succeeds, or fails for a reason unrelated to the recorded one',
      absentWhen: '',
    },
  };
  try {
    const dir = homePath('drafts');
    fs.mkdirSync(dir, { recursive: true });
    /*
     * A draft holds the failing call's arguments and two thousand characters
     * of its error output, which against a real service is the least
     * sanitised text in the session. This repository gitignores drafts/; a
     * CAIRN_HOME somebody made with mkdir does not, and that is the corpus a
     * careful person creates precisely so this repository is not involved.
     * So the directory carries its own exclusion, wherever it is.
     */
    const ignore = path.join(dir, '.gitignore');
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
    const safe = redactForLedger(JSON.stringify(draft, null, 2)).text;
    fs.writeFileSync(path.join(dir, `${session.id}-${tool.replace(/[^A-Za-z0-9_.-]+/g, '_')}.json`), `${safe}\n`);
  } catch (e) {
    process.stderr.write(`cairn-proxy: could not write draft: ${(e as Error).message}\n`);
  }
  try {
    observe(`${tool} [draft]`, [], 'mcp-proxy:draft', { by: session.agent, session: session.id });
  } catch { /* never fatal */ }
  return (
    `\n\n--- ${LABEL} ---\n` +
    `Earlier in this session ${tool} failed (${clip(hole.output, 200)}) and this call succeeded` +
    (differed.length ? `; the arguments differed in: ${differed.join(', ')}.` : '.') +
    ' If that failure contradicted a reasonable expectation, record it now with cairn_record, ' +
    'filling in title, claim, expectation, reality and workaround, and absentWhen if something on the machine made it stop:\n' +
    JSON.stringify(draft) +
    `\n--- end ---`
  );
}

/* ------------------------------------------------------------------------ */
/* Upstreams                                                                 */
/* ------------------------------------------------------------------------ */

interface Upstream {
  spec: UpstreamSpec;
  client: Client | null;
  caps: ServerCapabilities;
  instructions?: string;
  alive: boolean;
  lastError?: string;
  respawned: boolean;
}

/** Lifted from the SDK's 60s: a long-running tool must not fail only because it was proxied. */
const FORWARD = { timeout: 10 * 60 * 1000, resetTimeoutOnProgress: true } as const;

async function spawn(up: Upstream, onNotification: (u: Upstream, method: string, params: unknown) => void): Promise<void> {
  const client = new Client({ name: 'cairn-proxy', version: '0.2.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: up.spec.command,
    args: up.spec.args,
    env: { ...(process.env as Record<string, string>), ...(up.spec.env ?? {}) },
    stderr: 'inherit',
  });
  await client.connect(transport);
  up.client = client;
  up.caps = client.getServerCapabilities() ?? {};
  up.instructions = client.getInstructions();
  up.alive = true;
  up.lastError = undefined;
  /*
   * Chained, not replaced. Protocol.connect installs its own onclose, and it
   * is the one that rejects every pending request when the pipe goes. The
   * first version assigned over it, so an upstream that died mid-call left
   * that call waiting forever -- the exact failure the respawn exists for.
   */
  const sdkOnClose = transport.onclose;
  transport.onclose = () => {
    up.alive = false;
    up.lastError = 'exited';
    sdkOnClose?.();
  };
  const relay = (method: string) => (n: { params?: unknown }) => onNotification(up, method, n.params);
  client.setNotificationHandler(ToolListChangedNotificationSchema, relay('notifications/tools/list_changed'));
  client.setNotificationHandler(ResourceListChangedNotificationSchema, relay('notifications/resources/list_changed'));
  client.setNotificationHandler(PromptListChangedNotificationSchema, relay('notifications/prompts/list_changed'));
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, relay('notifications/resources/updated'));
  client.setNotificationHandler(LoggingMessageNotificationSchema, relay('notifications/message'));
}

/* ------------------------------------------------------------------------ */
/* Main                                                                      */
/* ------------------------------------------------------------------------ */

/* ------------------------------------------------------------------------ */
/* The gateway's own tools                                                   */
/* ------------------------------------------------------------------------ */

/*
 * The nudge on a failed result said "record it with cairn_record" and the
 * gateway did not offer one: the writer half lived in a separate MCP server
 * a client had to be told about. One integration point now carries both
 * halves. Names are checked against the upstreams' so a server that already
 * offers a tool called cairn_find keeps its own.
 */
const GATEWAY_TOOLS: Tool[] = [
  {
    name: 'cairn_find',
    description:
      'Search the ledger of recorded traps behind this gateway: paste an error you cannot explain, ' +
      'or describe what you are about to do. Silence means nothing is recorded, which is the common case.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'The error text, verbatim, or what you are about to do' } }, required: ['query'] },
  },
  {
    name: 'cairn_record',
    description:
      'Record a trap you just hit, so the next agent does not lose the same time to it. Use it AFTER you ' +
      'have solved something that surprised you — not for your own mistakes. Set `tool` to the MCP tool ' +
      'this is about, named exactly: that is what makes the finding come back on that tool. The `check` ' +
      'must EXIT NON-ZERO when the trap is absent, or be described in prose to be marked manual; ' +
      '`absentWhen` is what makes the trap stop happening.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        claim: { type: 'string', description: 'One falsifiable sentence' },
        expectation: { type: 'string', description: 'What a competent person would reasonably predict' },
        reality: { type: 'string', description: 'What actually happens instead' },
        workaround: { type: 'string' },
        tool: { type: 'string', description: 'The MCP tool this is about, named exactly' },
        evidence: { type: 'array', items: { type: 'object', properties: { command: { type: 'string' }, output: { type: 'string' } }, required: ['command', 'output'] } },
        check: {
          type: 'object',
          properties: { command: { type: 'string' }, confirmedIf: { type: 'string' }, refutedIf: { type: 'string' }, absentWhen: { type: 'string' } },
          required: ['command', 'confirmedIf', 'refutedIf'],
        },
        by: { type: 'string', description: 'Your model or agent identifier' },
      },
      required: ['title', 'claim', 'expectation', 'reality', 'evidence', 'check'],
    },
  },
];

/**
 * What a forwarded call is written down as.
 *
 * ARGUMENT VALUES ARE OFF BY DEFAULT, and that is the difference between a
 * usage ledger and a copy of somebody's database.
 *
 * The report needs to count calls per tool -- "warned in N of the M sessions
 * that called it" needs the M -- and it reads the first whitespace-delimited
 * token as the tool name. Nothing in it needs the values. But this used to
 * write `JSON.stringify(args)` in full, into a file that is git-tracked,
 * union-merged, and which USING.md tells people to `git add`. Against a
 * fixture that is a query string. Against a real CRM it is SOQL, create and
 * update payloads, and whole customer records -- names, phones, amounts, free
 * text -- none of which redactForLedger removes, because it was built for
 * tokens and ids.
 *
 * Key names come from the tool's own inputSchema, so they are shape rather
 * than content, and they are what makes a hole in the corpus legible later:
 * `query_records [args: filters, object]` says what was attempted without
 * saying whose data it was attempted on.
 *
 * CAIRN_RECORD_ARGS=1 restores the values, for a fixture or a corpus of your
 * own where that is the interesting part. It is opt-in because the safe
 * default has to be the one you get by forgetting.
 */
function callRecord(name: string, args: Record<string, unknown>): string {
  if (process.env.CAIRN_RECORD_ARGS) return `${name} ${JSON.stringify(args)}`;
  const keys = Object.keys(args).sort();
  return keys.length ? `${name} [args: ${keys.join(', ')}]` : name;
}

const textResult = (text: string, isError = false) => ({ isError, content: [{ type: 'text' as const, text }] });

/* ------------------------------------------------------------------------ */
/* Main                                                                      */
/* ------------------------------------------------------------------------ */

async function main() {
  const specs = parseArgs(process.argv.slice(2));
  const single = specs.length === 1;
  /* Exposed name -> wire name, when several upstreams share one tool list. */
  const expose = (up: Upstream, raw: string) => (single ? raw : `${up.spec.name}__${raw}`);

  /*
   * THE PROXY IS THE SESSION, over stdio. Every CLI invocation an agent makes
   * runs in its own process with no way to know which session it belongs to,
   * so the ledger's session field was 'adhoc' for everything. This process
   * lives exactly one client session over stdio and can name it. Hosted,
   * each client gets its own SessionState and the id the transport minted.
   */
  process.env.CAIRN_SESSION ??= `proxy-${Date.now().toString(36)}-${process.pid}`;

  /* Declared before the relay that reads it; assigned once the upstreams have said what they offer. */
  let capabilities: ServerCapabilities = {};
  const upstreams: Upstream[] = specs.map((spec) => ({
    spec, client: null, caps: {}, alive: false, respawned: false,
  }));
  /* Every live server, so an upstream notification reaches every session. */
  const servers = new Set<Server>();

  /* Owner maps, rebuilt whenever a list is fetched or an upstream says it changed. */
  const toolOwner = new Map<string, { up: Upstream; raw: string }>();
  const promptOwner = new Map<string, { up: Upstream; raw: string }>();
  const resourceOwner = new Map<string, Upstream>();
  const templateOwner = new Map<string, Upstream>();

  const forwardNotification = (up: Upstream, method: string, params: unknown) => {
    if (method === 'notifications/tools/list_changed') toolOwner.clear();
    if (method === 'notifications/prompts/list_changed') promptOwner.clear();
    if (method === 'notifications/resources/list_changed') { resourceOwner.clear(); templateOwner.clear(); }
    for (const server of servers) {
      try {
        /* Only what this server declared: the SDK refuses the rest, and a refusal here must not throw into a handler. */
        if (method === 'notifications/message' && !capabilities.logging) return;
        if (method.startsWith('notifications/resources/') && !capabilities.resources) return;
        if (method === 'notifications/prompts/list_changed' && !capabilities.prompts) return;
        void server.notification({ method, params: (params ?? {}) as Record<string, unknown> });
      } catch {
        /* a notification that cannot be relayed is dropped, never fatal */
      }
    }
  };

  for (const up of upstreams) {
    try {
      await spawn(up, forwardNotification);
    } catch (e) {
      up.alive = false;
      up.lastError = (e as Error).message;
      console.error(`cairn-proxy: upstream "${up.spec.name}" did not start: ${up.lastError}`);
    }
  }

  /*
   * THE PRE-DECISION INDEX. Warning "before the call" cannot happen between
   * the model's decision and the execution -- there is no model turn there,
   * and any text put there is either a deferral or arrives with the result.
   * Before the call therefore means before the DECISION, and the surfaces
   * that precede a decision are the ones already in context: the instructions
   * at connect, the tool definitions, and prior results. This index goes on
   * all three: one line per tool with a recorded trap, so the model knows
   * `delete_records` has one before it has ever reached for `delete_records`.
   */
  const INDEX_CAP = 8;
  async function trapIndex(session: SessionState, up: Upstream, findings: Finding[], except?: string): Promise<string[]> {
    if (!up.alive || !up.client) return [];
    let tools: Tool[];
    try {
      tools = (await up.client.listTools({}, FORWARD)).tools;
    } catch {
      return [];
    }
    const lines: string[] = [];
    for (const t of tools) {
      const name = expose(up, t.name);
      if (name === except) continue;
      const about = findingsAbout(up.spec.name, t.name, name, findings, propertyNames(t));
      if (!about.length) continue;
      const a = about[0];
      const where = a.props.length ? ` (argument ${a.props[0]})` : '';
      lines.push(`${name}${where}: "${clip(a.finding.title, 90)}" (${a.finding.id})${about.length > 1 ? ` +${about.length - 1}` : ''}`);
      served(session, a.finding.id, name, except === undefined ? 'connect-index' : 'first-contact');
      if (lines.length >= INDEX_CAP) break;
    }
    return lines;
  }

  /** One attempt to bring a dead upstream back, then an honest error result. */
  async function ensure(up: Upstream): Promise<boolean> {
    if (up.alive && up.client) return true;
    if (up.respawned) return false;
    up.respawned = true;
    try {
      await spawn(up, forwardNotification);
      up.respawned = false;
      return true;
    } catch (e) {
      up.lastError = (e as Error).message;
      return false;
    }
  }

  const alive = () => upstreams.filter((u) => u.alive && u.client);
  const anyCap = (k: keyof ServerCapabilities) => upstreams.some((u) => u.caps[k]);

  /*
   * Capabilities are the union of the upstreams', declared before the client
   * connects, because the SDK refuses to register a handler for anything
   * undeclared. Wrapping a server that offers resources and forwarding only
   * tools BREAKS that server, which is worse than not helping at all.
   */
  capabilities = {
    tools: { listChanged: true },
    ...(anyCap('resources')
      ? { resources: { subscribe: upstreams.some((u) => u.caps.resources?.subscribe), listChanged: true } }
      : {}),
    ...(anyCap('prompts') ? { prompts: { listChanged: true } } : {}),
    ...(anyCap('logging') ? { logging: {} } : {}),
    ...(anyCap('completions') ? { completions: {} } : {}),
  };

  async function allTools(): Promise<Tool[]> {
    toolOwner.clear();
    const out: Tool[] = [];
    for (const up of alive()) {
      let cursor: string | undefined;
      do {
        let page;
        try {
          page = await up.client!.listTools({ cursor }, FORWARD);
        } catch (e) {
          up.lastError = (e as Error).message;
          break;
        }
        for (const t of page.tools) {
          const name = expose(up, t.name);
          toolOwner.set(name, { up, raw: t.name });
          out.push({ ...t, name });
        }
        cursor = page.nextCursor;
      } while (cursor);
    }
    return out;
  }

  /** The instructions a session is handed at connect: the upstreams' own, then the index. */
  async function instructionsFor(session: SessionState): Promise<string> {
    const findings = localFindings().findings;
    const index: string[] = [];
    for (const up of upstreams) for (const line of await trapIndex(session, up, findings)) index.push(line);
    const upstreamOwn = upstreams
      .filter((u) => u.instructions)
      .map((u) => (single ? u.instructions! : `## ${u.spec.name}\n${u.instructions!}`));
    /*
     * Degraded: the upstreams' own instructions, and not a word of ours.
     * Describing a ledger that is not there spends the model's context on a
     * feature it cannot use, at the one moment it is deciding what this
     * server is for.
     */
    if (degraded()) return upstreamOwn.join('\n\n');
    return [
      ...upstreamOwn,
      '## Cairn',
      'Tool descriptions and results may carry a block marked "' + LABEL + '". That block is from ' +
        'the ledger of recorded traps kept by whoever configured this gateway, not from the service; ' +
        'judge whether it applies. This gateway also offers cairn_find, to search that ledger, and ' +
        'cairn_record: when a call fails in a way that contradicted a reasonable expectation and you ' +
        'work it out, record it.' +
        (index.length
          ? `\n\nTools with a recorded trap, as of this session's start:\n${index.map((l) => `- ${l}`).join('\n')}`
          : ''),
    ].join('\n\n');
  }

  /**
   * One Server per session, all closing over the same upstreams. The
   * handlers are the same whether the transport is stdio or HTTP; what
   * differs is only how many of these exist at once.
   */
  function buildServer(session: SessionState, instructions: string): Server {
    const server = new Server({ name: 'cairn-proxy', version: '0.3.0' }, { capabilities, instructions });
    servers.add(server);

    /* ---- tools ---------------------------------------------------------- */

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = await allTools();
      const { findings } = localFindings();
      let budget = DESCRIPTION_CAP;
      const described = tools.map((t) => {
        const owner = toolOwner.get(t.name)!;
        const about = findingsAbout(owner.up.spec.name, owner.raw, t.name, findings, propertyNames(t));
        const d = describe(session, t, about, budget);
        if (about.length && budget > 0) budget--;
        return d;
      });
      const taken = new Set(described.map((t) => t.name));
      /*
       * Degraded means there is no corpus to search or write to, so the
       * gateway's own two tools are withdrawn rather than offered and made
       * to fail. An advertised tool that cannot work costs a model a call
       * and a wrong conclusion about why.
       */
      const own = degraded() ? [] : GATEWAY_TOOLS.filter((g) => !taken.has(g.name));
      return { tools: [...described, ...own] };
    });

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;

      /* ---- the gateway's own tools, unless an upstream owns the name ---- */
      if (!toolOwner.has(req.params.name) && req.params.name === 'cairn_record') {
        /*
         * origin: 'agent'. The caller is a model, and what it is recording
         * came out of an upstream tool -- which means it can be written by
         * anyone who can write into the system that tool reads. Its check is
         * never executed here, whatever this machine's execution policy says.
         */
        const outcome = await recordSubmission(args, { by: session.agent, origin: 'agent' });
        try { observe(`cairn_record ${outcome.ok ? outcome.finding!.id : 'refused'}`, [], 'mcp-proxy:record', { by: session.agent, session: session.id }); } catch { /* never fatal */ }
        return textResult(outcome.message, !outcome.ok);
      }
      if (!toolOwner.has(req.params.name) && req.params.name === 'cairn_find') {
        const query = String(args.query ?? '');
        const { findings } = localFindings();
        let hits: ReturnType<typeof retrieve> = [];
        try { hits = retrieve(query, findings, { limit: 5 }); } catch { /* a corpus problem never reaches the caller */ }
        try { observe(query, hits, 'mcp-proxy:find', { by: session.agent, session: session.id }); } catch { /* never fatal */ }
        if (!hits.length) return textResult('Nothing recorded bears on that.');
        return textResult(
          hits.map((h) => `${h.finding.id} [${h.strength}] ${h.finding.title}\n  ACTUALLY: ${clip(h.finding.reality, 400)}` + (h.finding.workaround ? `\n  INSTEAD: ${clip(h.finding.workaround, 400)}` : '')).join('\n\n'),
        );
      }

      let owner = toolOwner.get(req.params.name);
      if (!owner) {
        await allTools();
        owner = toolOwner.get(req.params.name);
      }
      if (!owner) {
        return textResult(`cairn-proxy: no upstream offers a tool named "${req.params.name}"`, true);
      }
      if (!(await ensure(owner.up))) {
        return textResult(`cairn-proxy: upstream "${owner.up.spec.name}" is not running (${owner.up.lastError ?? 'unknown'})`, true);
      }

      let result: Awaited<ReturnType<Client['callTool']>>;
      try {
        result = await owner.up.client!.callTool({ ...req.params, name: owner.raw }, undefined, FORWARD);
      } catch (e) {
        /*
         * A transport failure mid-call is reported as the tool's error, not as
         * the proxy's exception: the client gets a result it can read and act
         * on, which is the only thing a gateway is allowed to hand back.
         */
        owner.up.lastError = (e as Error).message;
        return textResult(`cairn-proxy: call to "${req.params.name}" failed: ${owner.up.lastError}`, true);
      }

      try {
        const { findings } = localFindings();
        const about = findingsAbout(owner.up.spec.name, owner.raw, req.params.name, findings, Object.keys(args));
        const isError = result.isError === true;
        const ctx = { by: session.agent, session: session.id };
        const ownText = Array.isArray(result.content)
          ? (result.content as Array<{ type: string; text?: string }>).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n')
          : '';
        /*
         * Every forwarded call is written down, error or not: the report
         * counts calls per tool, and "warned in N of M sessions that called
         * it" needs the M. Arguments are redacted by observe() before they
         * are written, because a query's arguments are the least sanitised
         * text an agent produces.
         */
        observe(callRecord(req.params.name, args), [], isError ? 'mcp-proxy:error' : 'mcp-proxy:call', ctx);
        if (isError) session.holes.set(req.params.name, { args, output: ownText, at: new Date().toISOString() });
        let note = annotate(session, req.params.name, about, isError, args);
        if (!isError) note += draftFor(session, req.params.name, args);
        /*
         * FIRST CONTACT. `instructions` is the right place for the index and
         * not every client honours it; a result is read by all of them. So the
         * first result from each upstream carries the index once, minus the tool
         * just called (its own note is already here), and never again.
         */
        if (!session.introduced.has(owner.up.spec.name)) {
          session.introduced.add(owner.up.spec.name);
          const index = await trapIndex(session, owner.up, findings, req.params.name);
          if (index.length) {
            note += `\n\n--- ${LABEL} ---\nOther tools from this server with a recorded trap:\n` +
              index.map((l) => `- ${l}`).join('\n') + `\n--- end ---`;
          }
        }
        if (note) {
          const content = Array.isArray(result.content) ? result.content : [];
          result.content = [...content, { type: 'text', text: note.replace(/^\n+/, '') }];
        }
      } catch {
        /* The result is the user's; a failure here must never withhold it. */
      }
      return result;
    });

    /* ---- resources ------------------------------------------------------ */

    if (capabilities.resources) {
      const withResources = () => alive().filter((u) => u.caps.resources);

      server.setRequestHandler(ListResourcesRequestSchema, async () => {
        resourceOwner.clear();
        const resources: Array<Record<string, unknown>> = [];
        for (const up of withResources()) {
          let cursor: string | undefined;
          do {
            let page;
            try { page = await up.client!.listResources({ cursor }, FORWARD); } catch { break; }
            for (const r of page.resources) { resourceOwner.set(r.uri, up); resources.push(r); }
            cursor = page.nextCursor;
          } while (cursor);
        }
        return { resources };
      });

      server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
        templateOwner.clear();
        const resourceTemplates: Array<Record<string, unknown>> = [];
        for (const up of withResources()) {
          let cursor: string | undefined;
          do {
            let page;
            try { page = await up.client!.listResourceTemplates({ cursor }, FORWARD); } catch { break; }
            for (const t of page.resourceTemplates) { templateOwner.set(t.uriTemplate, up); resourceTemplates.push(t); }
            cursor = page.nextCursor;
          } while (cursor);
        }
        return { resourceTemplates };
      });

      /** The owner by exact URI, else by a template prefix, else whoever answers. */
      async function ownerOf(uri: string): Promise<Upstream[]> {
        const exact = resourceOwner.get(uri);
        if (exact?.alive) return [exact];
        for (const [tpl, up] of templateOwner) {
          const prefix = tpl.split('{')[0];
          if (prefix && uri.startsWith(prefix) && up.alive) return [up];
        }
        return withResources();
      }

      server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
        let last: Error | null = null;
        for (const up of await ownerOf(req.params.uri)) {
          try {
            return await up.client!.readResource(req.params, FORWARD);
          } catch (e) { last = e as Error; }
        }
        throw last ?? new Error(`no upstream serves ${req.params.uri}`);
      });

      if (capabilities.resources.subscribe) {
        server.setRequestHandler(SubscribeRequestSchema, async (req) => {
          for (const up of await ownerOf(req.params.uri)) {
            if (!up.caps.resources?.subscribe) continue;
            try { return await up.client!.subscribeResource(req.params, FORWARD); } catch { /* next */ }
          }
          return {};
        });
        server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
          for (const up of await ownerOf(req.params.uri)) {
            if (!up.caps.resources?.subscribe) continue;
            try { return await up.client!.unsubscribeResource(req.params, FORWARD); } catch { /* next */ }
          }
          return {};
        });
      }
    }

    /* ---- prompts -------------------------------------------------------- */

    if (capabilities.prompts) {
      server.setRequestHandler(ListPromptsRequestSchema, async () => {
        promptOwner.clear();
        const prompts: Array<Record<string, unknown>> = [];
        for (const up of alive().filter((u) => u.caps.prompts)) {
          let cursor: string | undefined;
          do {
            let page;
            try { page = await up.client!.listPrompts({ cursor }, FORWARD); } catch { break; }
            for (const p of page.prompts) {
              const name = expose(up, p.name);
              promptOwner.set(name, { up, raw: p.name });
              prompts.push({ ...p, name });
            }
            cursor = page.nextCursor;
          } while (cursor);
        }
        return { prompts };
      });

      server.setRequestHandler(GetPromptRequestSchema, async (req) => {
        let owner = promptOwner.get(req.params.name);
        if (!owner) {
          /* Lists are fetched lazily; a client may ask for a prompt before listing. */
          for (const up of alive().filter((u) => u.caps.prompts)) {
            try {
              const page = await up.client!.listPrompts({}, FORWARD);
              for (const p of page.prompts) promptOwner.set(expose(up, p.name), { up, raw: p.name });
            } catch { /* skip */ }
          }
          owner = promptOwner.get(req.params.name);
        }
        if (!owner) throw new Error(`no upstream offers a prompt named "${req.params.name}"`);
        return owner.up.client!.getPrompt({ ...req.params, name: owner.raw }, FORWARD);
      });
    }

    /* ---- completions and logging --------------------------------------- */

    if (capabilities.completions) {
      server.setRequestHandler(CompleteRequestSchema, async (req) => {
        const ref = req.params.ref;
        let targets: Array<{ up: Upstream; params: typeof req.params }> = [];
        if (ref.type === 'ref/prompt') {
          const owner = promptOwner.get(ref.name);
          if (owner) targets = [{ up: owner.up, params: { ...req.params, ref: { ...ref, name: owner.raw } } }];
        } else if (ref.type === 'ref/resource') {
          const up = templateOwner.get(ref.uri) ?? resourceOwner.get(ref.uri);
          if (up) targets = [{ up, params: req.params }];
        }
        if (!targets.length) targets = alive().filter((u) => u.caps.completions).map((up) => ({ up, params: req.params }));
        for (const t of targets) {
          try { return await t.up.client!.complete(t.params, FORWARD); } catch { /* next */ }
        }
        return { completion: { values: [] } };
      });
    }

    if (capabilities.logging) {
      server.setRequestHandler(SetLevelRequestSchema, async (req) => {
        for (const up of alive().filter((u) => u.caps.logging)) {
          try { await up.client!.setLoggingLevel(req.params.level, FORWARD); } catch { /* one upstream's refusal is not the client's problem */ }
        }
        return {};
      });
    }

    /*
     * Attribution comes from initialize, which arrives AFTER connect returns:
     * read at connect time the client's name was always undefined and every
     * ledger row said 'cli'.
     */
    server.oninitialized = () => {
      const client = server.getClientVersion();
      if (client?.name) session.agent = process.env.CAIRN_AGENT ?? client.name;
    };
    return server;
  }

  /* ---- freshness ------------------------------------------------------ */

  /*
   * A finding banked mid-session must reach the tool list before the next
   * decision, not the next session. The corpus is fingerprinted on every
   * request already; this is the idle case, and the timer is unref'd so it
   * never keeps a finished session alive.
   */
  localFindings();
  setInterval(() => {
    try {
      if (localFindings().changed) for (const server of servers) void server.sendToolListChanged();
    } catch { /* never fatal */ }
  }, 2000).unref();

  /*
   * When the client goes, so does everything this started. A proxy that
   * outlives its client leaves one orphaned upstream per server, each holding
   * the pipes it inherited, which is how a test runner hung for five minutes
   * and how a laptop accumulates a dozen headless MCP servers by Friday.
   */
  const shutdown = async () => {
    await Promise.allSettled(upstreams.map((u) => u.client?.close()));
    process.exit(0);
  };
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, () => { void shutdown(); });

  if (HTTP_PORT === null) {
    /* ---- stdio: one process, one session ------------------------------ */
    const session = newSession(process.env.CAIRN_SESSION!);
    session.agent = process.env.CAIRN_AGENT;
    const server = buildServer(session, await instructionsFor(session));
    const transport = new StdioServerTransport();
    transport.onclose = () => { void shutdown(); };
    process.stdin.on('end', () => { void shutdown(); });
    await server.connect(transport);
    return;
  }

  /* ---- hosted: one process, a session per client ---------------------- */

  /*
   * Streamable HTTP at /mcp. Every client that initialises gets its own
   * SessionState, its own Server and its own transport, keyed by the session
   * id the transport minted; the upstreams are shared, which is the point of
   * hosting -- one running copy of each MCP server, however many agents are
   * behind it. A request without a session id that is not an initialize is
   * refused, which is what the SDK's stateful mode expects.
   *
   * Bound to loopback unless CAIRN_HTTP_HOST says otherwise. This is a
   * gateway that appends text to tool results; putting it on a network
   * interface is a decision, not a default.
   */
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const host = process.env.CAIRN_HTTP_HOST || '127.0.0.1';
  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sessions: transports.size, upstreams: upstreams.map((u) => ({ name: u.spec.name, alive: u.alive })), corpus: corpusDir() ?? null, degraded: degraded() }));
      return;
    }
    if (url.pathname !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    let body: unknown;
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch { body = null; }
    }
    const sid = req.headers['mcp-session-id'];
    const existing = typeof sid === 'string' ? transports.get(sid) : undefined;
    if (existing) {
      await existing.handleRequest(req, res, body);
      return;
    }
    if (req.method === 'POST' && isInitializeRequest(body)) {
      const session = newSession(randomUUID());
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => session.id,
        onsessioninitialized: (id) => { transports.set(id, transport); },
        onsessionclosed: (id) => { transports.delete(id); },
      });
      const server = buildServer(session, await instructionsFor(session));
      transport.onclose = () => { transports.delete(session.id); servers.delete(server); };
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'no session; send initialize first' }, id: null }));
  });
  await new Promise<void>((resolve) => httpServer.listen(HTTP_PORT!, host, resolve));
  const addr = httpServer.address();
  const port = typeof addr === 'object' && addr ? addr.port : HTTP_PORT;
  process.stderr.write(`cairn-proxy: listening on http://${host}:${port}/mcp (corpus ${corpusDir() ?? 'none'})\n`);
}

main().catch((e) => {
  console.error(`cairn-proxy: ${(e as Error).message}`);
  process.exit(1);
});
