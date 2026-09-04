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
  CallToolResultSchema,
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
import { matchEnvironment } from '../src/lib/cairn/precondition';
import { FindingSchema, type Finding } from '../src/lib/cairn/schema';
import { homePath } from '../src/lib/cairn/home';
import { observe } from '../src/lib/cairn/observe';
import { recordSubmission } from '../src/lib/cairn/recordFinding';
import { redactForLedger } from '../src/lib/cairn/safety';
import { shapeOf, diffSurface, findingNames, type ToolShape, type SurfaceChange } from '../src/lib/cairn/toolsurface';
import { summarise, detect, type CallSummary } from '../src/lib/cairn/contradiction';
import { tierOf } from '../src/lib/cairn/brief';
import { recordNote, discardNote, finishNotes, openNotesFor, ageDays } from '../src/lib/cairn/notes';
import { attest, verification, verificationLine } from '../src/lib/cairn/attest';
import { recordArc, readArcs } from '../src/lib/cairn/arcs';
import { standing } from '../src/lib/cairn/decay';

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

/**
 * A finding is a prior, and a prior is only as good as when it was last
 * checked. So the note says what its standing rests on -- verified by a
 * check, attested by someone, or never confirmed -- and whether a machine
 * could re-run it at all, and it asks the one observer who can answer for
 * the manual half: the agent that has just used the tool. "Trust decay is
 * existential"; the alternative is a standing that reads fresh because the
 * corpus is new, which is a new car looking reliable.
 */
function fullNote(f: Finding): string {
  /*
   * The value tier. A finding cheap to rediscover (cost: minutes) is delivered
   * as a hint, not the full block: measured on the records-opus gateway trial,
   * pushing the full account at a trap the model recovers from on its own cost
   * ~2x MORE than leaving it alone, because the block's overhead outweighed a
   * discovery it would have made anyway. The hint names the trap and the one
   * call that expands it, so the reader — not the gate — decides whether to
   * spend the attention. Nothing is withheld; it is one call away. (tierOf +
   * the full/hint split live in brief.ts, shared with session-start injection.)
   */
  if (tierOf(f.cost) === 'hint') {
    return (
      `\n\n--- ${LABEL} ---\n` +
      `${f.id} — ${f.title} — a known, cheap-to-work-around trap on this tool; ` +
      `call cairn_find {"query":"${f.id}"} for the fix if the result looks off.\n` +
      `--- end ---`
    );
  }
  const v = verification(f);
  const ask = v.due
    ? `${v.lastConfirmedAt ? `Not re-confirmed in ${Math.floor(v.daysSinceConfirmed!)} days. ` : 'Never confirmed. '}If this call showed the trap still holds — or that it no longer does — say so: `
    : 'If this call showed it no longer holds: ';
  return (
    `\n\n--- ${LABEL} ---\n` +
    `${f.id} — ${f.title}\n` +
    `STANDING: ${verificationLine(f)}\n` +
    `WHAT HAPPENS: ${clip(f.reality, 400)}` +
    (f.workaround ? `\nINSTEAD: ${clip(f.workaround, 400)}` : '') +
    `\n${ask}cairn_observe {"finding":"${f.id}","verdict":"confirmed"|"refuted","note":"what the call returned"}` +
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
      const line = `[${LABEL}: ${clip(a.finding.title, 110)} (${a.finding.id}, ${standing(a.finding)}). Details arrive on the result.]`;
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
        ? `[${LABEL}: ${n} recorded trap${n === 1 ? '' : 's'} — "${clip(onTool[0].finding.title, 110)}" (${onTool[0].finding.id}, ${standing(onTool[0].finding)}). Details arrive on the result.]`
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
  /** Per upstream, how many of its surface events this session has been told about. */
  surfaceSeen: Map<string, number>;
  /** The last few successful calls per tool, for the contradiction writer. */
  recent: Map<string, CallSummary[]>;
  /** Tools for which a contradiction draft has already been offered this session. */
  contradicted: Set<string>;
  /** Tools whose unfinished notes have been offered back this session. */
  notesOffered: Set<string>;
}

function newSession(id: string): SessionState {
  return {
    id, introduced: new Set(), callsByTool: new Map(), shown: new Set(), nudged: new Set(), holes: new Map(), drafted: new Set(), surfaceSeen: new Map(), recent: new Map(), contradicted: new Set(), notesOffered: new Set(),
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

/*
 * THE CONTRADICTION WRITER -- cairn-0045's trigger, in the one place that can
 * see both halves of it. The hole-to-draft loop above catches a call that
 * failed and then worked; this catches the trap that never fails: a call
 * that returned nothing, or N with nothing saying more, and a later call to
 * the same tool with the same arguments plus one more that returned what the
 * first had implied was not there. The rules for what counts, and the rules
 * for staying quiet, are in src/lib/cairn/contradiction.ts.
 *
 * Nothing is written to the corpus. A draft with both calls as evidence goes
 * to drafts/ and rides on the result, once per tool per session, labelled,
 * hedged, and offered: the agent or a person records it through
 * cairn_record or ignores it. A proxy that wrote findings on the strength of
 * a diff would make the ledger something nobody vouched for.
 */
const RECENT_PER_TOOL = 8;
function contradictionFor(session: SessionState, tool: string, args: Record<string, unknown>, ownText: string): string {
  const history = session.recent.get(tool) ?? [];
  const now = summarise(args, ownText);
  const found = session.contradicted.has(tool) ? null : detect(history, now);
  history.push(now);
  if (history.length > RECENT_PER_TOOL) history.shift();
  session.recent.set(tool, history);
  if (!found) return '';
  session.contradicted.add(tool);
  const { earlier, later, added } = found;
  const before = earlier.items === 0 ? 'nothing' : `${earlier.items} item(s), with nothing saying more existed`;
  const draft = {
    tool,
    title: '',
    claim: '',
    expectation: '',
    reality: '',
    workaround: `Pass ${added.join(', ')} explicitly.`,
    evidence: [
      { command: `${tool} ${JSON.stringify(earlier.args)}`, output: earlier.text.slice(0, 2000), note: `returned ${before}` },
      { command: `${tool} ${JSON.stringify(later.args)}`, output: later.text.slice(0, 2000), note: `returned ${later.items} item(s)` },
    ],
    check: {
      command: `Call ${tool} without ${added.join(', ')} and confirm it returns ${earlier.items === 0 ? 'nothing' : `${earlier.items} item(s) with no sign of more`}; then with ${added.join(', ')} and confirm it returns more.`,
      confirmedIf: 'the first call returns the smaller result with no indication that more exists, and the second returns more',
      refutedIf: 'the first call returns the same as the second, or says that more exists',
      absentWhen: '',
    },
  };
  try {
    const dir = homePath('drafts');
    fs.mkdirSync(dir, { recursive: true });
    const ignore = path.join(dir, '.gitignore');
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
    const safe = redactForLedger(JSON.stringify(draft, null, 2)).text;
    fs.writeFileSync(path.join(dir, `${session.id}-${tool.replace(/[^A-Za-z0-9_.-]+/g, '_')}-contradiction.json`), `${safe}\n`);
  } catch (e) {
    process.stderr.write(`cairn-proxy: could not write draft: ${(e as Error).message}\n`);
  }
  try {
    observe(`${tool} [contradiction ${found.kind}]`, [], 'mcp-proxy:contradiction', { by: session.agent, session: session.id });
  } catch { /* never fatal */ }
  return (
    `\n\n--- ${LABEL} ---\n` +
    `Two calls to ${tool} in this session may contradict each other. Earlier, ${tool} ${JSON.stringify(earlier.args)} returned ${before}; ` +
    `now, with ${added.join(', ')} added, it returned ${later.items} item(s). ` +
    'If the first result was wrong rather than merely a different question -- a default that silently scoped, capped or missed -- ' +
    'record it now with cairn_record, filling in title, claim, expectation and reality; a draft with both calls as evidence follows. ' +
    'If the first was simply a narrower question, ignore this.\n' +
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
  /** Consecutive failed restarts, the earliest time the next may be tried, and the attempt in flight if any. */
  respawnFailures: number;
  nextRespawnAt: number;
  respawning: Promise<boolean> | null;
  /**
   * What the server offered the last time it was asked, and every change
   * since. The gateway is the one component that sits in front of a real
   * server all day, so it is the one positioned to notice a tool appearing,
   * vanishing, being renamed, re-annotated or re-shaped -- which is the
   * moment a finding naming that tool starts to rot. Noticed, recorded and
   * told to the model on the result surface; never acted on. A client asked
   * for that server, not for this gateway's opinion of it.
   */
  surface: ToolShape[] | null;
  surfaceEvents: Array<{ at: string; changes: SurfaceChange[] }>;
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
        /* Limits on the argument itself, where the model reads them before it writes: a refusal is a round trip, a description is free. */
        title: { type: 'string', maxLength: 120, description: 'One line, what does not work. At most 120 characters.' },
        claim: { type: 'string', minLength: 40, maxLength: 2000, description: 'One falsifiable sentence, 40 to 2000 characters' },
        expectation: { type: 'string', maxLength: 2000, description: 'What a competent person would reasonably predict. Up to 2000 characters.' },
        reality: { type: 'string', maxLength: 4000, description: 'What actually happens instead. Up to 4000 characters.' },
        workaround: { type: 'string', maxLength: 4000, description: 'What to do instead. Up to 4000 characters.' },
        tool: { type: 'string', maxLength: 120, description: 'The MCP tool this is about, named exactly' },
        evidence: {
          type: 'array', minItems: 1, maxItems: 20, description: 'The call you made and what it returned, verbatim; 1 to 20 entries',
          items: { type: 'object', properties: { command: { type: 'string', maxLength: 4000 }, output: { type: 'string', maxLength: 20000, description: 'Up to 20000 characters; cut the middle, keep the error' } }, required: ['command', 'output'] },
        },
        check: {
          type: 'object',
          properties: {
            command: { type: 'string', maxLength: 4000, description: 'Shell that exits non-zero when the trap is absent; or a sentence in prose, which marks it manual' },
            confirmedIf: { type: 'string', maxLength: 2000 },
            refutedIf: { type: 'string', maxLength: 2000 },
            absentWhen: { type: 'string', maxLength: 2000, description: 'What makes the trap stop happening' },
          },
          required: ['command', 'confirmedIf', 'refutedIf'],
        },
        by: { type: 'string', maxLength: 200, description: 'Your model or agent identifier' },
        note: { type: 'string', description: 'The id of the cairn_note this finishes, if it grew out of one' },
        arc: { type: 'string', pattern: '^arc-[0-9a-f]{8}$', description: 'When this records a fail-then-recover arc the Bash hook offered: its id, so the choice is counted' },
        distinctFrom: {
          type: 'array',
          maxItems: 3,
          description:
            'Only when a near-duplicate refusal named findings that are NOT your trap: one entry per id, with `because` saying what makes yours different. The refusal prints the exact value to send.',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, because: { type: 'string', minLength: 20, maxLength: 500 } },
            required: ['id', 'because'],
          },
        },
      },
      required: ['title', 'claim', 'expectation', 'reality', 'evidence', 'check'],
    },
  },
  /*
   * FRESHNESS THAT IS REAL. A finding served on a result is a prior; the
   * agent that just used the tool is the only observer who can say whether
   * it held, and for the manual half of a corpus it is the only observer
   * there will ever be. An observation is the format's own mechanism for
   * that, made reachable here. Unsigned, so one line cannot veto a signed
   * corpus; a refutation is shown as contested until confirmations from
   * distinct signers outnumber it two to one.
   */
  {
    name: 'cairn_observe',
    description:
      'After a tool call showed whether a recorded trap still holds: say so. "confirmed" if the trap bit as the ' +
      'finding describes, "refuted" if the call did what the finding says it cannot, "inconclusive" if you could not ' +
      'tell. This is what keeps a finding\'s standing honest; a finding nobody re-confirms decays into a lead, and one ' +
      'that has stopped being true is worse than none.',
    inputSchema: {
      type: 'object',
      properties: {
        finding: { type: 'string', pattern: '^cairn-\\d{4}$', description: 'The finding id, as it appeared on the result' },
        verdict: { type: 'string', enum: ['confirmed', 'refuted', 'inconclusive'] },
        note: { type: 'string', maxLength: 4000, description: 'What the call returned. Required for refuted and inconclusive.' },
      },
      required: ['finding', 'verdict'],
    },
  },
  /*
   * THE SECOND TIER. When there is no time for a finding -- a deploy failing
   * in front of the person -- a note takes what the session already has and
   * nothing that needs thought. It is kept in drafts/, outside the corpus:
   * cairn_find, the tool index and federation all read cairn/, so a note is
   * unreachable by construction until cairn_record turns it into a finding.
   * The bar for cairn/ does not move. See src/lib/cairn/notes.ts.
   */
  {
    name: 'cairn_note',
    description:
      'When there is no time for a finding: note what just did not work, in one call, with what you already have — ' +
      'the tool, the exact command and its output, the fix if any. Kept as a draft outside the corpus: not searchable, ' +
      'not delivered, not published, until you finish it with cairn_record (pass its id as `note`). It is offered back ' +
      'once, the next session that touches the tool, and dropped after 14 days. Pass {"discard": "<note id>"} to drop one now.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', maxLength: 120, description: 'One line, what did not work. At most 120 characters.' },
        tool: { type: 'string', maxLength: 120, description: 'The MCP tool this is about, named exactly. What brings it back.' },
        evidence: {
          type: 'array', minItems: 1, maxItems: 20, description: 'The call you made and what it returned, verbatim',
          items: { type: 'object', properties: { command: { type: 'string', maxLength: 4000 }, output: { type: 'string', maxLength: 20000 }, note: { type: 'string', maxLength: 2000 } }, required: ['command', 'output'] },
        },
        workaround: { type: 'string', maxLength: 4000, description: 'What worked instead, if anything did' },
        by: { type: 'string', maxLength: 200, description: 'Your model or agent identifier' },
        arc: { type: 'string', pattern: '^arc-[0-9a-f]{8}$', description: 'When banking a fail-then-recover arc the Bash hook offered: its id, so the choice is counted' },
        discard: { type: 'string', description: 'Instead of noting: the id of a note to drop' },
        dismiss: { type: 'string', pattern: '^arc-[0-9a-f]{8}$', description: 'Instead of noting: the id of an offered arc to dismiss, with `as`' },
        as: { type: 'string', enum: ['my-mistake', 'not-surprising'], description: 'Why the arc is not a trap: a slip you made, or a failure you already understood' },
      },
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

/**
 * The tap, counted. An arc the Bash hook offered is answered here -- banked
 * through cairn_note or cairn_record, or dismissed as a slip or as expected
 * -- and the answer goes beside the offer in ~/.cairn/arcs.jsonl, which is
 * the detector's calibration. Only an offered arc can be answered.
 */
function countArc(arc: string, choice: 'bank' | 'my-mistake' | 'not-surprising', session: SessionState): boolean {
  const offered = readArcs().find((r) => r.arc === arc && r.choice === 'offered');
  if (!offered) return false;
  try {
    recordArc({ arc, key: offered.key, failing: offered.failing, choice, by: session.agent });
    observe(`${offered.key} [arc ${choice}]`, [], `mcp-proxy:arc-${choice}`, { by: session.agent, session: session.id });
  } catch { /* never fatal */ }
  return true;
}

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
    spec, client: null, caps: {}, alive: false, respawnFailures: 0, nextRespawnAt: 0, respawning: null, surface: null, surfaceEvents: [],
  }));
  /* Every live server, so an upstream notification reaches every session. */
  const servers = new Set<Server>();

  /* Owner maps, rebuilt whenever a list is fetched or an upstream says it changed. */
  const toolOwner = new Map<string, { up: Upstream; raw: string }>();
  const promptOwner = new Map<string, { up: Upstream; raw: string }>();
  const resourceOwner = new Map<string, Upstream>();
  const templateOwner = new Map<string, Upstream>();

  /**
   * NOTICE, RECORD, NEVER ENFORCE. Every complete look at an upstream's tool
   * list passes through here. The first is the baseline; each later one is
   * diffed against it, and a difference goes three places: stderr, where the
   * operator sees it; the ledger, tagged `mcp-proxy:surface-<kind>` with the
   * findings whose triggers name the tool, so `cairn:report` can list the
   * knowledge that may have rotted; and the upstream's event log, from which
   * each session is told once on its next result. Nothing here changes what
   * is routed or offered.
   */
  function noteSurface(up: Upstream, tools: Tool[]): void {
    const shapes = tools.map(shapeOf);
    if (!up.surface) { up.surface = shapes; return; }
    const changes = diffSurface(up.surface, shapes);
    up.surface = shapes;
    if (!changes.length) return;
    up.surfaceEvents.push({ at: new Date().toISOString(), changes });
    const findings = localFindings().findings;
    for (const c of changes) {
      process.stderr.write(`cairn-proxy: ${up.spec.name}: ${c.detail}\n`);
      const named = findings.filter((f) => findingNames(f.triggers, c.tool, up.spec.name) || (c.to !== undefined && findingNames(f.triggers, c.to, up.spec.name)));
      for (const f of named) process.stderr.write(`cairn-proxy:   ${f.id} names ${c.tool} in its triggers and may no longer apply\n`);
      try {
        observe(c.detail, named.map((f, i) => ({ finding: f, rank: i + 1, strength: 'strong' })) as never, `mcp-proxy:surface-${c.kind}`, { by: 'gateway', session: process.env.CAIRN_SESSION });
      } catch { /* never fatal */ }
    }
  }

  /** Re-read the whole list, every page, and note what moved. */
  async function refreshSurface(up: Upstream): Promise<void> {
    if (!up.alive || !up.client) return;
    const tools: Tool[] = [];
    let cursor: string | undefined;
    try {
      do {
        const page = await up.client.listTools({ cursor }, FORWARD);
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
    } catch {
      return; /* a list that cannot be read is not a change */
    }
    noteSurface(up, tools);
  }

  const forwardNotification = (up: Upstream, method: string, params: unknown) => {
    if (method === 'notifications/tools/list_changed') { toolOwner.clear(); void refreshSurface(up); }
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
   * AN EMPTY VEHICLE THAT LOOKS FULL IS WORSE THAN ONE THAT VISIBLY FAILED.
   *
   * The first version logged a failed start and carried on, and the client
   * saw a connected server offering cairn_find, cairn_record and nothing
   * else -- fifty-three Salesforce tools gone, the connector green, and
   * nothing anywhere saying why. An OAuth refresh hiccup at nine in the
   * morning would have produced exactly that.
   *
   * cairn-0046 says the passenger must not crash the vehicle. This is the
   * other case: the vehicle did not start, and the honest thing is to be
   * indistinguishable from no gateway, which means failing the way the
   * client would have seen the upstream fail on its own -- the process
   * exits, the client marks the server failed, and its own reconnect
   * applies. The reason is on stderr, which is where the client would have
   * had to look without us too. One retry first, because the failure this
   * is written for is transient.
   */
  for (const up of upstreams.filter((u) => !u.alive)) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      await spawn(up, forwardNotification);
      console.error(`cairn-proxy: upstream "${up.spec.name}" started on the second attempt`);
    } catch (e) {
      up.lastError = (e as Error).message;
    }
  }
  if (!upstreams.some((u) => u.alive)) {
    console.error(
      `cairn-proxy: no upstream started (${upstreams.map((u) => `${u.spec.name}: ${u.lastError}`).join('; ')}).\n` +
        'cairn-proxy: exiting so the client sees the failure it would have seen without the gateway.',
    );
    process.exit(1);
  }
  /* The baseline: what each server offered at connect, so a later look has something to differ from. */
  for (const up of upstreams) await refreshSurface(up);

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
      lines.push(`${name}${where}: "${clip(a.finding.title, 90)}" (${a.finding.id}, ${standing(a.finding)})${about.length > 1 ? ` +${about.length - 1}` : ''}`);
      served(session, a.finding.id, name, except === undefined ? 'connect-index' : 'first-contact');
      if (lines.length >= INDEX_CAP) break;
    }
    return lines;
  }

  /**
   * THE OTHER HALF OF WHAT PEOPLE WRITE DOWN.
   *
   * Of the trigger strings in this repository's own corpus, 37 of 37 name a
   * program or a program and its subcommand -- `next build`, `playwright
   * install`, `sf agent` -- and none name an MCP tool. A finding about
   * platform behaviour reached through a CLI has no tool for the gateway to
   * intercept: no description to annotate, no argument schema, no result of
   * its own to ride back on. Until now it reached nobody who did not ask,
   * and cairn-0035 is the measurement that agents do not ask.
   *
   * This is the one push surface that is not tool-specific: the
   * instructions at connect, which the model reads before any decision in
   * the session, Bash decisions included. It is coarse, session-wide, and
   * before the decision; it names the program, not the moment. That is less
   * than the four surfaces a tool-shaped finding gets, and it is honest
   * about being less: one line per program, the finding's title, its id,
   * and where to get the rest.
   *
   * A trigger counts as a program here when it has the shape programsIn()
   * produces -- one word, or a word and a subcommand -- and names nothing
   * any upstream offers. Findings the tool index already carries are not
   * repeated. Preconditions are honoured the way preflight honours them: a
   * finding whose precondition fails on this machine is noise, not caution.
   * Same cap as the tool index, in corpus order; a session-wide index that
   * grows without bound is the one that gets ignored.
   */
  const PROGRAM_TRIGGER = /^[a-z][a-z0-9._-]*(?: [a-z][a-z0-9-]+)?$/i;
  function programIndex(session: SessionState, findings: Finding[], except: Set<string>, surface: string): string[] {
    const toolNames = new Set<string>();
    for (const up of upstreams) for (const t of up.surface ?? []) for (const n of namesFor(up.spec.name, t.name, expose(up, t.name))) toolNames.add(n.toLowerCase());
    const byProgram = new Map<string, Finding[]>();
    for (const f of findings) {
      if (f.status !== 'active' || except.has(f.id)) continue;
      if (f.precondition?.length && !matchEnvironment(f.precondition).matches) continue;
      for (const raw of f.triggers ?? []) {
        const t = raw.trim().toLowerCase();
        if (!PROGRAM_TRIGGER.test(t) || t.startsWith('mcp__') || toolNames.has(t)) continue;
        const list = byProgram.get(t) ?? [];
        if (!list.some((x) => x.id === f.id)) list.push(f);
        byProgram.set(t, list);
        break; /* one line per finding; its first program-shaped trigger names it */
      }
    }
    const lines: string[] = [];
    for (const [program, fs] of [...byProgram.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const f = fs[0];
      lines.push(`\`${program}\`: "${clip(f.title, 90)}" (${f.id})${fs.length > 1 ? ` +${fs.length - 1}` : ''}`);
      served(session, f.id, program, surface);
      if (lines.length >= INDEX_CAP) break;
    }
    return lines;
  }
  const PROGRAMS_HEADING =
    'Programs with a recorded trap. Coarse, on purpose: this names the program, not the moment. ' +
    'Before running one of these, cairn_find with the finding id hands over the whole finding:';
  /* Index lines read `(cairn-0004)` or `(cairn-0004, stale)`; the standing word must not hide the id from the dedupe. */
  const idsIn = (lines: string[]) => new Set(lines.flatMap((l) => [...l.matchAll(/\((cairn-\d{4})(?:, [a-z]+)?\)/g)].map((m) => m[1])));

  /**
   * Bring a dead upstream back, with backoff, for as long as the session
   * lasts. The first version tried once and latched: one failed restart and
   * every later call in the session errored, which in a day-long session
   * in front of a real connector is a dead server until somebody notices.
   * Now a failed restart waits 1s, 2s, 4s ... capped at 30s, before the next
   * attempt; a call inside the wait gets an honest error naming the wait;
   * concurrent calls during an attempt share it rather than each failing.
   */
  const RESPAWN_CAP_MS = 30_000;
  async function ensure(up: Upstream): Promise<boolean> {
    if (up.alive && up.client) return true;
    if (up.respawning) return up.respawning;
    if (Date.now() < up.nextRespawnAt) return false;
    up.respawning = (async () => {
      try {
        await spawn(up, forwardNotification);
        up.respawnFailures = 0;
        up.nextRespawnAt = 0;
        process.stderr.write(`cairn-proxy: upstream "${up.spec.name}" is back\n`);
        return true;
      } catch (e) {
        up.lastError = (e as Error).message;
        up.respawnFailures++;
        const wait = Math.min(RESPAWN_CAP_MS, 1000 * 2 ** (up.respawnFailures - 1));
        up.nextRespawnAt = Date.now() + wait;
        process.stderr.write(`cairn-proxy: upstream "${up.spec.name}" did not restart (${up.lastError}); next attempt in ${wait / 1000}s\n`);
        return false;
      } finally {
        up.respawning = null;
      }
    })();
    return up.respawning;
  }
  const retryHint = (up: Upstream) => {
    const wait = Math.max(0, Math.ceil((up.nextRespawnAt - Date.now()) / 1000));
    return wait ? `; restart will be retried in ${wait}s` : '';
  };

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
    /* A listing is the moment a dead upstream is missed; try to bring it back first, within its backoff. */
    for (const up of upstreams) if (!up.alive) await ensure(up);
    for (const up of alive()) {
      const mine: Tool[] = [];
      let complete = true;
      let cursor: string | undefined;
      do {
        let page;
        try {
          page = await up.client!.listTools({ cursor }, FORWARD);
        } catch (e) {
          up.lastError = (e as Error).message;
          complete = false;
          break;
        }
        for (const t of page.tools) {
          const name = expose(up, t.name);
          toolOwner.set(name, { up, raw: t.name });
          out.push({ ...t, name });
          mine.push(t);
        }
        cursor = page.nextCursor;
      } while (cursor);
      if (complete) noteSurface(up, mine);
    }
    return out;
  }

  /** The instructions a session is handed at connect: the upstreams' own, then the index. */
  async function instructionsFor(session: SessionState): Promise<string> {
    const findings = localFindings().findings;
    const index: string[] = [];
    for (const up of upstreams) for (const line of await trapIndex(session, up, findings)) index.push(line);
    const programs = programIndex(session, findings, idsIn(index), 'connect-program-index');
    const upstreamOwn = upstreams
      .filter((u) => u.instructions)
      .map((u) => (single ? u.instructions! : `## ${u.spec.name}\n${u.instructions!}`));
    /*
     * An upstream that did not start, when others did: its tools are absent
     * and the client has to be told where they went. This is about the
     * vehicle, not about Cairn, so it is said whether or not there is a
     * corpus. (With a single upstream the process has already exited.)
     */
    for (const u of upstreams.filter((x) => !x.alive)) {
      upstreamOwn.push(`## cairn-proxy\nUpstream "${u.spec.name}" did not start (${u.lastError ?? 'unknown'}). Its tools are absent from this list; a restart is attempted on each tools/list.`);
    }
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
      /*
       * What this is, and what it is not, in the model's first look at the
       * server. A ledger of tool behaviour is easy to mistake for memory,
       * and an agent that looks here for preferences or project history
       * wastes its context and then distrusts what it does find. The
       * advantage is stated conditionally -- a check and a date let you
       * tell whether an entry is still true only once something has re-run
       * the check -- because most entries have not been re-run yet, and the
       * standing word says so.
       */
      'A ledger of tool behaviour: what breaks, where, and what to do instead. It is not memory: no ' +
        'preferences, no project history, nothing about who decided what or why. Each entry carries a check ' +
        'and a date, so where the check has been re-run you can tell whether it is still true; read the standing. ' +
        'Blocks marked "' + LABEL + '" on tool descriptions and results are from that ledger, kept by ' +
        'whoever configured this gateway, not from the service; judge whether they apply. cairn_find searches it; ' +
        'cairn_record adds a failure that contradicted a reasonable expectation once you worked it out; ' +
        'cairn_observe says whether a finding still held after a call.' +
        (index.length
          ? `\n\nTools with a recorded trap, as of this session's start:\n${index.map((l) => `- ${l}`).join('\n')}`
          : '') +
        (programs.length ? `\n\n${PROGRAMS_HEADING}\n${programs.map((l) => `- ${l}`).join('\n')}` : ''),
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
    /* A session is told about changes from its own start, not about history it never saw. */
    for (const up of upstreams) session.surfaceSeen.set(up.spec.name, up.surfaceEvents.length);

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

    server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;

      /* ---- the gateway's own tools, unless an upstream owns the name ---- */
      if (!toolOwner.has(req.params.name) && req.params.name === 'cairn_record') {
        /*
         * origin: 'agent'. The caller is a model, and what it is recording
         * came out of an upstream tool -- which means it can be written by
         * anyone who can write into the system that tool reads. Its check is
         * never executed here, whatever this machine's execution policy says.
         */
        const { note: noteId, arc: arcId, ...submission } = args as Record<string, unknown> & { note?: unknown; arc?: unknown };
        const outcome = await recordSubmission(submission, { by: session.agent, origin: 'agent' });
        if (outcome.ok && typeof arcId === 'string') countArc(arcId, 'bank', session);
        try { observe(`cairn_record ${outcome.ok ? outcome.finding!.id : 'refused'}`, [], 'mcp-proxy:record', { by: session.agent, session: session.id }); } catch { /* never fatal */ }
        let closed = '';
        if (outcome.ok) {
          try {
            const done = finishNotes(outcome.finding!, typeof noteId === 'string' ? noteId : undefined);
            if (done.length) closed = `\nFinished note${done.length > 1 ? 's' : ''} ${done.map((n) => n.id).join(', ')}.`;
          } catch { /* a note that cannot be closed is not a failed record */ }
        }
        return textResult(outcome.message + closed, !outcome.ok);
      }
      if (!toolOwner.has(req.params.name) && req.params.name === 'cairn_observe') {
        const outcome = attest(args, { by: session.agent ?? 'agent', via: `cairn-proxy, client ${session.agent ?? 'unknown'}`, keyId: process.env.CAIRN_KEY });
        try { observe(`cairn_observe ${String(args.finding ?? '?')} ${outcome.ok ? String(args.verdict) : 'refused'}`, [], `mcp-proxy:observe-${outcome.ok ? String(args.verdict) : 'refused'}`, { by: session.agent, session: session.id }); } catch { /* never fatal */ }
        return textResult(outcome.message, !outcome.ok);
      }
      if (!toolOwner.has(req.params.name) && req.params.name === 'cairn_note') {
        if (typeof args.dismiss === 'string') {
          const as = args.as === 'my-mistake' || args.as === 'not-surprising' ? args.as : null;
          if (!as) return textResult('dismiss needs `as`: "my-mistake" (a slip you made) or "not-surprising" (a failure you already understood).', true);
          const counted = countArc(args.dismiss, as, session);
          return textResult(counted ? `Dismissed ${args.dismiss} as ${as}; not offered again for ${as === 'my-mistake' ? 'a week' : 'ninety days'}.` : `No offered arc with id ${args.dismiss}.`, !counted);
        }
        if (typeof args.discard === 'string') {
          const dropped = discardNote(args.discard);
          try { observe(`cairn_note discard ${args.discard}`, [], 'mcp-proxy:note-discarded', { by: session.agent, session: session.id }); } catch { /* never fatal */ }
          return textResult(dropped ? `Discarded ${dropped.id}.` : `No open note with id ${args.discard}.`, !dropped);
        }
        const { arc: arcId, ...noteArgs } = args as Record<string, unknown> & { arc?: unknown };
        const outcome = recordNote(noteArgs, { by: session.agent, session: session.id });
        try { observe(`cairn_note ${outcome.ok ? outcome.note!.id : 'refused'}`, [], 'mcp-proxy:note', { by: session.agent, session: session.id }); } catch { /* never fatal */ }
        if (outcome.ok && typeof arcId === 'string') countArc(arcId, 'bank', session);
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
        return textResult(`cairn-proxy: upstream "${owner.up.spec.name}" is not running (${owner.up.lastError ?? 'unknown'})${retryHint(owner.up)}`, true);
      }

      let result: Awaited<ReturnType<Client['callTool']>>;
      try {
        /*
         * `request`, not `callTool`, and the difference is a tool that works
         * without this gateway and fails with it.
         *
         * callTool applies the CLIENT's half of the output contract: if the
         * tool declared an outputSchema, the SDK requires structuredContent
         * back and throws when it is missing (client/index.js, "has an output
         * schema but did not return structured content"). A relay must not
         * make that check. It is not the caller -- the real client is -- and
         * the check is only armed here because the proxy has listed the tools,
         * which it does for routing, not on anyone's behalf.
         *
         * Measured against a server that declares a schema and returns text
         * anyway, which is what a server not written on this SDK does:
         *
         *     direct    { content: [{ type: 'text', text: 'two' }] }
         *     gateway   isError, 'MCP error -32600: Tool strict_textonly has
         *               an output schema but did not return structured content'
         *
         * The upstream answered. The proxy threw the answer away and reported
         * a failure the client never asked it to detect. The client's own SDK
         * will apply whatever validation it wants to the result it is handed;
         * a client on another SDK, or an older one, or one that never listed
         * the tool, gets the working call it would have had. Forwarding the
         * result unexamined is the whole job.
         */
        /*
         * And the client's cancel travels with it. `extra.signal` aborts when
         * the client sends notifications/cancelled; handed to the forwarded
         * request, the SDK sends the same notification upstream and the
         * tool's own handler can stop. Without it the proxy dropped the
         * response and the upstream ran the call to completion -- a write
         * the person cancelled, still written.
         */
        result = await owner.up.client!.request(
          { method: 'tools/call', params: { ...req.params, name: owner.raw } },
          CallToolResultSchema,
          { ...FORWARD, signal: extra.signal },
        );
      } catch (e) {
        if (extra.signal.aborted) {
          try { observe(callRecord(req.params.name, args), [], 'mcp-proxy:cancelled', { by: session.agent, session: session.id }); } catch { /* never fatal */ }
          return textResult(`cairn-proxy: call to "${req.params.name}" was cancelled by the client`, true);
        }
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
        if (!isError && !degraded()) note += contradictionFor(session, req.params.name, args, ownText);
        /*
         * FIRST CONTACT. `instructions` is the right place for the index and
         * not every client honours it; a result is read by all of them. So the
         * first result from each upstream carries the index once, minus the tool
         * just called (its own note is already here), and never again.
         */
        if (!session.introduced.has(owner.up.spec.name)) {
          session.introduced.add(owner.up.spec.name);
          const index = await trapIndex(session, owner.up, findings, req.params.name);
          /* The program index rides here too, once per session: a client that ignores instructions still reads a result. */
          const programs = session.introduced.size === 1 ? programIndex(session, findings, idsIn(index), 'first-contact-program-index') : [];
          if (index.length || programs.length) {
            note += `\n\n--- ${LABEL} ---` +
              (index.length ? `\nOther tools from this server with a recorded trap:\n${index.map((l) => `- ${l}`).join('\n')}` : '') +
              (programs.length ? `\n${PROGRAMS_HEADING}\n${programs.map((l) => `- ${l}`).join('\n')}` : '') +
              `\n--- end ---`;
          }
        }
        /*
         * THE SURFACE MOVED. Once per change, on the next result from that
         * server: what changed, and which findings name the tool that did.
         * Withheld when degraded, because a gateway with no corpus must be
         * indistinguishable from no gateway.
         */
        const events = owner.up.surfaceEvents;
        const seen = session.surfaceSeen.get(owner.up.spec.name) ?? 0;
        if (events.length > seen && !degraded()) {
          session.surfaceSeen.set(owner.up.spec.name, events.length);
          const fresh = events.slice(seen).flatMap((e) => e.changes);
          const named = findings.filter((f) => fresh.some((c) => findingNames(f.triggers, c.tool, owner!.up.spec.name) || (c.to !== undefined && findingNames(f.triggers, c.to, owner!.up.spec.name))));
          note +=
            `\n\n--- ${LABEL} ---\nThis server's tools changed while this session was open:\n` +
            fresh.map((c) => `- ${c.detail}`).join('\n') +
            (named.length ? `\nFindings that name a changed tool, and may no longer apply as written: ${named.map((f) => `${f.id} (${f.title})`).join('; ')}` : '') +
            `\n--- end ---`;
          try {
            observe(`${owner.up.spec.name} [surface told]`, named.map((f, i) => ({ finding: f, rank: i + 1, strength: 'strong' })) as never, 'mcp-proxy:told-surface', ctx);
          } catch { /* never fatal */ }
        }
        /*
         * THE CLOSE. An unfinished note about this tool, left by an earlier
         * session, is offered back once on the first result from the tool:
         * the person is in the same territory again and the memory is fresh.
         * Never the session that wrote it, never after it is abandoned, never
         * when degraded.
         */
        if (!degraded() && !session.notesOffered.has(req.params.name)) {
          session.notesOffered.add(req.params.name);
          let open: ReturnType<typeof openNotesFor> = [];
          try { open = openNotesFor(namesFor(owner.up.spec.name, owner.raw, req.params.name)).filter((n) => n.session !== session.id); } catch { /* never fatal */ }
          if (open.length) {
            const now = new Date();
            note +=
              `\n\n--- ${LABEL} ---\n` +
              open.slice(0, 3).map((n) => {
                const days = Math.floor(ageDays(n, now));
                return `You left an unfinished note about ${req.params.name} ${days === 0 ? 'earlier today' : `${days} day${days === 1 ? '' : 's'} ago`}: "${n.title}" (${n.id}). ` +
                  `Finish it with cairn_record, passing note: "${n.id}" — the evidence is already in it: ${clip(JSON.stringify(n.evidence), 300)}` +
                  (n.workaround ? ` Workaround noted: ${clip(n.workaround, 120)}` : '') +
                  ` — or discard it with cairn_note {"discard": "${n.id}"}.`;
              }).join('\n') +
              `\n--- end ---`;
            try { observe(`${req.params.name} [note offered]`, [], 'mcp-proxy:note-offered', ctx); } catch { /* never fatal */ }
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

      server.setRequestHandler(ReadResourceRequestSchema, async (req, extra) => {
        let last: Error | null = null;
        for (const up of await ownerOf(req.params.uri)) {
          try {
            return await up.client!.readResource(req.params, { ...FORWARD, signal: extra.signal });
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

      server.setRequestHandler(GetPromptRequestSchema, async (req, extra) => {
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
        return owner.up.client!.getPrompt({ ...req.params, name: owner.raw }, { ...FORWARD, signal: extra.signal });
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
