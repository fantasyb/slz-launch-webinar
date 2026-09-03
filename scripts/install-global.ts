/**
 * cairn:install — make Cairn present in EVERY session, not just one wrapped server.
 *
 *   npm run cairn:install                 # do it
 *   npm run cairn:install -- --dry-run    # show the exact edits, write nothing
 *   npm run cairn:install -- --uninstall  # remove exactly what was added
 *   npm run cairn:install -- --home ~/pilot --instructions ~/.claude/CLAUDE.md --instructions ~/AGENTS.md
 *
 * WHY THIS EXISTS. Wiring Cairn as a wrapper around one MCP server makes it
 * invisible to every session that does not load that server — a fresh terminal
 * in another directory knows nothing about it. Recorded as a finding. This
 * install fixes it at the machine level, and does exactly two things, because
 * "every session has knowledge" is exactly two things:
 *
 *   1. TOOLS PRESENT EVERYWHERE. The standalone server (bin/cairn-mcp.js) is
 *      registered at USER scope in ~/.claude.json, so cairn_find / cairn_brief
 *      / cairn_record exist in every session, any directory.
 *
 *   2. THE AGENT KNOWS TO USE THEM. A managed block is written into the global
 *      agent-instruction file(s) — CLAUDE.md, AGENTS.md, whatever the agent
 *      reads at startup. Presence is not knowledge: MCP tools are pull, and the
 *      measurement (cairn-0035) is that agents do not pull unprompted. The block
 *      is the standing instruction that makes a blank session reach for the tool.
 *
 * THE BLOCK CARRIES NO FACTS, ON PURPOSE. It is a usage protocol — when to call,
 * how to call, and the one line that says Cairn is tool-behaviour knowledge, not
 * memory. A block that made claims could go stale; this one cannot, because it
 * asserts nothing about any tool. All the decayable knowledge lives in the
 * corpus, where the standing/check machinery governs it. The always-loaded part
 * is safe precisely because it is empty of facts.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not enable execution (policy stays
 * off, and lives outside the corpus). It does not fetch or run anything remote
 * (cairn-0014). It does not wrap your existing MCP servers — that is PUSH, it is
 * higher-stakes because it re-points production servers, and it is a separate
 * deliberate step. So after this install: tools and knowledge are global; PUSH
 * (unasked annotations) is not, and neither is pure Bash/code work with no
 * server. The summary says so plainly rather than letting you assume otherwise.
 *
 * Every write is backed up first and every write is idempotent: a managed block
 * is replaced in place, never duplicated, and --uninstall removes exactly the
 * block and the one server entry, nothing else.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const DRY = has('--dry-run') || has('--print');
const UNINSTALL = has('--uninstall');

function opt(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : undefined;
}
/** Repeatable: every `--instructions <path>`. */
function opts(name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === `--${name}` && argv[i + 1]) out.push(argv[i + 1]);
  return out;
}

const HOME = process.env.HOME || os.homedir();
const expand = (p: string) => (p.startsWith('~') ? path.join(HOME, p.slice(1)) : path.resolve(p));

/* The Cairn code checkout: two levels up from scripts/. */
const REPO = path.resolve(__dirname, '..');
const SERVER_BIN = path.join(REPO, 'bin', 'cairn-mcp.js');
const SLEEP_BIN = path.join(REPO, 'bin', 'cairn-sleep.js');

const MCP_NAME = 'cairn';
const BEGIN = '<!-- cairn:begin (managed by `npm run cairn:install` — edits between these markers are overwritten) -->';
const END = '<!-- cairn:end -->';

/* Layer 1: usage protocol, no facts. See the header. */
function block(): string {
  return [
    BEGIN,
    '## Cairn — recorded tool behaviour (this is not memory)',
    '',
    'Cairn is a ledger of how your tools actually behave — what breaks, where, and',
    'what to do instead. It holds no preferences, no project history, no decisions;',
    'only falsifiable findings about tools. It is not memory.',
    '',
    '- Before non-trivial work with a tool, and the moment a tool call surprises you',
    '  (an empty success, a wrong result, an error you did not expect), call',
    '  `cairn_find` with the error text verbatim or with what you were about to do.',
    '  Silence means nothing is recorded — the common case, and not a failure.',
    '- When you solve something that surprised you, bank it so the next agent does',
    '  not lose the same time: `cairn_record` if you can state a check that exits',
    '  non-zero when the trap is absent, or `cairn_note` if you are mid-task and only',
    '  have the failing call and the fix.',
    '- Read a finding\'s standing before you rely on it: fresh is safe, aging is worth',
    '  re-checking, stale is a lead and not a fact.',
    '- If a note at session start says consolidated candidates are waiting, they were',
    '  harvested automatically from earlier transcripts and are not yet findings. Look',
    '  only if one names a trap you can state a check for; promote that one with',
    '  `cairn_record`. Ignoring them is fine — they decay unused.',
    END,
  ].join('\n');
}

/* --- corpus home --------------------------------------------------------- */
/*
 * Order: an explicit --home; else an existing ~/pilot corpus (so a machine that
 * already has findings is not split into a second corpus); else the stable
 * product default ~/.cairn/corpus. Refuse a home inside the code checkout,
 * because the corpus is the user's and must not live in a directory `git pull`
 * will overwrite.
 */
function resolveHome(): string {
  const explicit = opt('home');
  let home: string;
  if (explicit) home = expand(explicit);
  else if (fs.existsSync(path.join(HOME, 'pilot', 'cairn'))) home = path.join(HOME, 'pilot');
  else home = path.join(HOME, '.cairn', 'corpus');

  if (path.resolve(home) === REPO || path.resolve(home).startsWith(REPO + path.sep)) {
    throw new Error(`--home ${home} is inside the Cairn code checkout (${REPO}); a corpus there is destroyed by git pull. Point it elsewhere, e.g. ~/pilot.`);
  }
  return home;
}

/* --- backups ------------------------------------------------------------- */
function backup(file: string): string | null {
  if (!fs.existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${file}.cairn-bak-${stamp}`;
  fs.copyFileSync(file, dest);
  return dest;
}

/* --- the instruction block, in one or more files ------------------------- */
/*
 * One clean managed region, or none. A prior run interrupted mid-write can
 * leave an orphan BEGIN with no END, or a duplicated pair; guessing where such
 * a block ends risks deleting user content, so we refuse and let a human make
 * it clean. Content integrity beats convenience on the user's own files.
 */
function assertCleanMarkers(text: string, file: string): void {
  const begins = (text.match(new RegExp(escapeRe(BEGIN), 'g')) ?? []).length;
  const ends = (text.match(new RegExp(escapeRe(END), 'g')) ?? []).length;
  const b = text.indexOf(BEGIN);
  const e = text.indexOf(END);
  const clean = (begins === 0 && ends === 0) || (begins === 1 && ends === 1 && e > b);
  if (!clean) {
    throw new Error(
      `${file} has malformed Cairn markers (${begins} begin, ${ends} end) — probably an interrupted earlier run. ` +
        'Open it and leave exactly one `cairn:begin ... cairn:end` region or none, then re-run. ' +
        'Refusing to guess where the block ends, because that risks deleting your content.',
    );
  }
}
function escapeRe(x: string): string {
  return x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function upsertBlock(file: string): 'added' | 'updated' | 'unchanged' {
  const body = block();
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  assertCleanMarkers(existing, file);
  const b = existing.indexOf(BEGIN);
  const e = existing.indexOf(END);

  let next: string;
  if (b !== -1 && e !== -1 && e > b) {
    const before = existing.slice(0, b);
    const after = existing.slice(e + END.length);
    next = before + body + after;
  } else {
    next = existing.trimEnd() + (existing.trim() ? '\n\n' : '') + body + '\n';
  }
  if (next === existing) return 'unchanged';
  if (!DRY) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    backup(file);
    fs.writeFileSync(file, next);
  }
  return b !== -1 ? 'updated' : 'added';
}

function removeBlock(file: string): boolean {
  if (!fs.existsSync(file)) return false;
  const existing = fs.readFileSync(file, 'utf8');
  assertCleanMarkers(existing, file);
  const b = existing.indexOf(BEGIN);
  const e = existing.indexOf(END);
  if (b === -1 || e === -1 || e < b) return false;
  const next = (existing.slice(0, b).trimEnd() + '\n' + existing.slice(e + END.length).replace(/^\n+/, '')).trimEnd() + '\n';
  if (!DRY) {
    backup(file);
    fs.writeFileSync(file, next);
  }
  return true;
}

/* --- the server entry in ~/.claude.json ---------------------------------- */
interface ClaudeConfig {
  mcpServers?: Record<string, unknown>;
  [k: string]: unknown;
}
/*
 * Refuse a file we cannot rewrite losslessly. We edit by JSON.parse ->
 * stringify, and that silently truncates any integer past 2^53:
 * 9007199254740993 becomes ...992. That is silent corruption of the user's
 * most important config files, so we detect it and refuse rather than write
 * the damaged version. String contents are blanked first so a big number
 * inside a token (an id, a hash) does not trip it -- only bare JSON numbers
 * count. False positives cost a refusal with a clear message, which is the
 * safe direction. Shared by ~/.claude.json (the server) and ~/.claude/settings.json
 * (the hooks): both are the user's, and both must be edited losslessly or not at all.
 */
function readJsonObject(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8');
  const bareNumbers = raw.replace(/"(?:\\.|[^"\\])*"/g, '""');
  if (/(?:^|[^\w.])\d{16,}(?![\w.])/.test(bareNumbers)) {
    throw new Error(
      `${file} contains a number too large to survive a JSON round-trip; refusing to rewrite it so it is not silently corrupted. ` +
        'Edit it by hand, or move it aside and re-run.',
    );
  }
  try {
    const v = JSON.parse(raw);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      throw new Error('top level is not a JSON object');
    }
    return v as Record<string, unknown>;
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${(err as Error).message}); refusing to touch it. Fix or move it, then re-run.`);
  }
}
function readConfig(file: string): ClaudeConfig {
  return readJsonObject(file) as ClaudeConfig;
}
function upsertServer(file: string, home: string): 'added' | 'updated' | 'unchanged' {
  const cfg = readConfig(file);
  const entry = { command: 'node', args: [SERVER_BIN], env: { CAIRN_HOME: home } };
  const servers = (cfg.mcpServers ??= {});
  const before = JSON.stringify(servers[MCP_NAME]);
  const state = servers[MCP_NAME] === undefined ? 'added' : before === JSON.stringify(entry) ? 'unchanged' : 'updated';
  if (state === 'unchanged') return state;
  servers[MCP_NAME] = entry;
  if (!DRY) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    backup(file);
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  }
  return state;
}
function removeServer(file: string): boolean {
  const cfg = readConfig(file);
  if (!cfg.mcpServers || !(MCP_NAME in cfg.mcpServers)) return false;
  delete cfg.mcpServers[MCP_NAME];
  if (!DRY) {
    backup(file);
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  }
  return true;
}

/* --- the automatic hooks in ~/.claude/settings.json ---------------------- */
/*
 * This is what makes sleep run at all. A `npm run cairn:sleep` nobody types is a
 * feature that does not exist, so consolidation is wired to the session
 * lifecycle: SessionEnd harvests the transcript that just closed, SessionStart
 * reports what a prior session left. Both point at bin/cairn-sleep.js, which
 * never throws and always exits 0 — a hook on the session-open/close path must
 * not be able to break a session (cairn-0046).
 *
 * Ownership is by command substring: every group whose inner command names
 * cairn-sleep.js is ours. Upsert removes ours and re-adds one fresh group per
 * event (so a changed --home updates in place, never duplicates); uninstall
 * removes ours and leaves every other hook untouched. We never read or rewrite
 * a hook we did not write.
 */
interface HookEntry {
  type?: string;
  command?: string;
  [k: string]: unknown;
}
interface HookGroup {
  hooks?: HookEntry[];
  [k: string]: unknown;
}
const HOOK_EVENTS: Array<{ event: string; flag: string }> = [
  { event: 'SessionEnd', flag: '--hook' },
  { event: 'SessionStart', flag: '--surface' },
];
const OURS = 'cairn-sleep.js';
const isOurs = (g: HookGroup) => Array.isArray(g.hooks) && g.hooks.some((h) => typeof h.command === 'string' && h.command.includes(OURS));

/** Strip every group we own from one event's array; returns the remainder. */
function withoutOurs(groups: unknown): HookGroup[] {
  return Array.isArray(groups) ? (groups as HookGroup[]).filter((g) => !isOurs(g)) : [];
}

function upsertHooks(file: string, home: string): 'added' | 'updated' | 'unchanged' {
  const cfg = readJsonObject(file);
  const hooks = (cfg.hooks && typeof cfg.hooks === 'object' && !Array.isArray(cfg.hooks) ? cfg.hooks : {}) as Record<string, unknown>;
  const before = JSON.stringify(cfg.hooks ?? null);
  const had = HOOK_EVENTS.some(({ event }) => Array.isArray(hooks[event]) && (hooks[event] as HookGroup[]).some(isOurs));

  for (const { event, flag } of HOOK_EVENTS) {
    const command = `node ${SLEEP_BIN} ${flag} --home ${home}`;
    const kept = withoutOurs(hooks[event]);
    kept.push({ hooks: [{ type: 'command', command }] });
    hooks[event] = kept;
  }
  cfg.hooks = hooks;

  if (JSON.stringify(cfg.hooks) === before) return 'unchanged';
  if (!DRY) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    backup(file);
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  }
  return had ? 'updated' : 'added';
}

function removeHooks(file: string): boolean {
  if (!fs.existsSync(file)) return false;
  const cfg = readJsonObject(file);
  if (!cfg.hooks || typeof cfg.hooks !== 'object') return false;
  const hooks = cfg.hooks as Record<string, unknown>;
  let changed = false;
  for (const { event } of HOOK_EVENTS) {
    if (!Array.isArray(hooks[event])) continue;
    const kept = withoutOurs(hooks[event]);
    if (kept.length !== (hooks[event] as unknown[]).length) changed = true;
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) delete cfg.hooks;
  if (changed && !DRY) {
    backup(file);
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  }
  return changed;
}

/* --- main ---------------------------------------------------------------- */
function main() {
  const claudeJson = expand(opt('claude-json') ?? path.join(HOME, '.claude.json'));
  const settingsJson = expand(opt('settings') ?? path.join(HOME, '.claude', 'settings.json'));
  /* Default target: the Claude Code global instruction file. Extra agent files
   * (an AGENTS.md, a Codex file) via repeated --instructions. */
  const instructionFiles = opts('instructions').map(expand);
  if (!instructionFiles.length) instructionFiles.push(path.join(HOME, '.claude', 'CLAUDE.md'));

  const banner = DRY ? 'DRY RUN — showing edits, writing nothing' : UNINSTALL ? 'UNINSTALL' : 'INSTALL';
  console.log(`\ncairn:install — ${banner}`);
  console.log('='.repeat(60));

  if (UNINSTALL) {
    const s = removeServer(claudeJson);
    console.log(`  ${s ? 'removed' : 'absent '}  server "${MCP_NAME}" in ${claudeJson}`);
    const h = removeHooks(settingsJson);
    console.log(`  ${h ? 'removed' : 'absent '}  sleep hooks in ${settingsJson}`);
    for (const f of instructionFiles) {
      const r = removeBlock(f);
      console.log(`  ${r ? 'removed' : 'absent '}  Cairn block in ${f}`);
    }
    console.log('\nBackups (if any) sit beside each file as <file>.cairn-bak-<time>.\n');
    return;
  }

  const home = resolveHome();
  if (!fs.existsSync(path.join(home, 'cairn'))) {
    if (!DRY) fs.mkdirSync(path.join(home, 'cairn'), { recursive: true });
    console.log(`  ${DRY ? 'would create' : 'created'}  corpus dir ${path.join(home, 'cairn')}`);
  }

  const s = upsertServer(claudeJson, home);
  console.log(`  ${s.padEnd(9)}  server "${MCP_NAME}" -> node ${SERVER_BIN}`);
  console.log(`             CAIRN_HOME=${home}`);
  const h = upsertHooks(settingsJson, home);
  console.log(`  ${h.padEnd(9)}  sleep hooks (SessionEnd + SessionStart) in ${settingsJson}`);
  for (const f of instructionFiles) {
    const r = upsertBlock(f);
    console.log(`  ${r.padEnd(9)}  Cairn block in ${f}`);
  }

  if (DRY) {
    console.log('\n--- the block that would be written ---');
    console.log(block());
    console.log('\nNothing was written.\n');
    return;
  }

  console.log('\n' + '='.repeat(60));
  console.log('Cairn is now global:');
  console.log('  · cairn_find / cairn_brief / cairn_record are available in every session');
  console.log('  · every session\'s instructions tell it when to consult them');
  console.log('  · sleep runs itself: every session\'s transcript is consolidated at its');
  console.log('    end, and the candidates it harvests are surfaced at the next session\'s');
  console.log('    start — nobody types a command, and nothing enters the corpus unchecked.');
  console.log('\nStill scoped, on purpose:');
  console.log('  · PUSH (unasked annotations on a tool\'s description and results) is active');
  console.log('    ONLY on servers wrapped by the gateway. This install wraps nothing.');
  console.log('    To extend push to a server, wrap it — see GATEWAY.md.');
  console.log('  · Pure Bash/CLI work with no MCP server is not covered here; that is the');
  console.log('    opt-in PostToolUse hook.');
  console.log('\nUndo any time: npm run cairn:install -- --uninstall');
  console.log('Restart your Claude session for the new server to load.\n');
}

try {
  main();
} catch (e) {
  console.error(`\ncairn:install: ${(e as Error).message}\n`);
  process.exit(1);
}
