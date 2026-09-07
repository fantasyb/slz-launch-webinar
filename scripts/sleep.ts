/**
 * cairn:sleep — the offline consolidation pass. Read a transcript nobody
 * annotated, harvest the surprise gaps, and leave provisional candidates in
 * drafts/ for selection to cull. Nobody decided to write; sleep read the trace.
 *
 *   npm run cairn:sleep -- <transcript.jsonl> [more.jsonl ...]
 *   npm run cairn:sleep -- --latest        # the most recent Claude Code transcript
 *   npm run cairn:sleep -- <t.jsonl> --print   # show candidates, write nothing
 *
 * Candidates go to $CAIRN_HOME/drafts/ (self-gitignored, the quarantine): a
 * candidate is not a finding. It is the raw material — the agent's own stated
 * expectation, the tool's actual result, and the agent's own correction. Then
 * CONSOLIDATION (src/lib/cairn/consolidate.ts) — the second half of sleep, and
 * for a long time the missing half — promotes the candidates that clear an
 * automatic gate into cairn/ as unverified, agent-authored findings, with
 * nobody in the loop, and settles the rest with a reason. It runs in --hook
 * right after the harvest, on demand as --consolidate, and detached from the
 * session-start trigger and every daemon tick. Selection (usage, decay, a later
 * cairn_observe) then decides whether a promoted finding survives. Sleep enables
 * no execution: a consolidated finding's check is manual and is never run.
 *
 * See src/lib/cairn/sleep.ts for why errors are below threshold and a model
 * update or a superset contradiction is what clears the gate (cairn-0045).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { homePath, setCairnHome } from '../src/lib/cairn/home';
import { parseTranscript, detectCandidates, type Candidate } from '../src/lib/cairn/sleep';
import { consolidate, describe, takeReport } from '../src/lib/cairn/consolidate';

const argv = process.argv.slice(2);
const PRINT = argv.includes('--print') || argv.includes('--dry-run');
/* Three automatic modes, wired by cairn:install into ~/.claude/settings.json so
 * nobody ever has to type the command — a command nobody types is a command
 * that does not exist. --hook runs at SessionEnd (the offline consolidation
 * pass, over the transcript that just closed: harvest, then promote); --surface
 * runs at SessionStart (report what sleep promoted and what still waits, so the
 * loop closes); --consolidate runs the promotion pass alone, and is what the
 * triage trigger spawns detached at session start and on every daemon tick.
 * The hook modes read Claude Code's hook JSON on stdin and MUST NOT fail the
 * session: everything is wrapped, and they always exit 0 (cairn-0046 — a hook
 * that throws at startup shows up as a broken session, not a broken hook). */
const HOOK = argv.includes('--hook');
const SURFACE = argv.includes('--surface');
const CONSOLIDATE = argv.includes('--consolidate');
/** --quiet: a breadcrumb on stderr only, for the detached spawn's log. */
const HOOK_QUIET = argv.includes('--quiet');

/*
 * Align CAIRN_HOME to --home BEFORE any corpus lookup. The harvest only ever
 * needed the drafts path, so this script computed it by hand; consolidation
 * WRITES to cairn/ through the one write path, which resolves the corpus via
 * cairnHome() — and without this the hook wired as `--home <corpus>` would have
 * recorded into whatever corpus the environment named (see triage.ts, which
 * learned the same lesson).
 */
{
  const i = argv.indexOf('--home');
  const explicit = i !== -1 && argv[i + 1] ? argv[i + 1] : undefined;
  if (explicit) setCairnHome(explicit.startsWith('~') ? path.join(os.homedir(), explicit.slice(1)) : explicit);
}

/** The corpus home for drafts: an explicit --home wins; else $CAIRN_HOME via homePath. */
function draftsDir(): string | null {
  const i = argv.indexOf('--home');
  const explicit = i !== -1 && argv[i + 1] ? argv[i + 1] : undefined;
  if (explicit) return path.join(explicit.startsWith('~') ? path.join(os.homedir(), explicit.slice(1)) : explicit, 'drafts');
  try {
    return homePath('drafts');
  } catch {
    return null;
  }
}

/** Read Claude Code's hook payload from stdin. Returns {} on anything unusual. */
function hookInput(): { transcript_path?: string; session_id?: string } {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** Write one candidate into drafts/ as a quarantined provisional. The filename
 * carries a content hash so distinct candidates never collide (an earlier
 * tool-plus-score scheme silently overwrote six Bash-4 candidates into one) and
 * an identical one is idempotent — re-consolidating a transcript rewrites the
 * same file rather than piling up duplicates. */
function writeCandidate(dir: string, c: Candidate, source: string): void {
  ensureDrafts(dir);
  const digest = crypto.createHash('sha256').update(`${c.tool}\0${c.expectation}\0${c.reality}\0${c.update}`).digest('hex').slice(0, 10);
  const name = `sleep-${path.basename(source, '.jsonl')}-${c.tool.replace(/[^A-Za-z0-9_.-]+/g, '_')}-${c.surprisal}-${digest}.json`;
  // Re-harvest is the NORMAL path (a resumed session re-consolidates its
  // transcript). The candidate file is also the mutable queue entry: settle
  // writes _defers into it and triage adds a check. Overwriting it reset that
  // state — deferrals reset so MAX_DEFERS never fired, an agent's check was
  // discarded — and recreating one already moved to admitted/rejected/leads
  // resurrected a settled candidate. So write ONLY if it exists nowhere yet.
  for (const p of [dir, path.join(dir, 'admitted'), path.join(dir, 'rejected'), path.join(dir, 'leads')]) {
    if (fs.existsSync(path.join(p, name))) return; // already queued or settled — leave its state alone
  }
  fs.writeFileSync(path.join(dir, name), JSON.stringify(draftFor(c, path.basename(source)), null, 2) + '\n');
}

/** Every Claude Code transcript on disk, with its mtime. The transcript is
 * written regardless of how a session died, so this is what makes catch-up
 * possible: a Ctrl-C'd session that never fired SessionEnd still left its trace. */
function allTranscripts(): Array<{ file: string; mtime: number }> {
  const root = path.join(os.homedir(), '.claude', 'projects');
  const out: Array<{ file: string; mtime: number }> = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) {
        try {
          out.push({ file: p, mtime: fs.statSync(p).mtimeMs });
        } catch {
          /* raced with a write; skip */
        }
      }
    }
  };
  walk(root);
  return out;
}

function latestTranscript(): string | null {
  const all = allTranscripts();
  return all.length ? all.reduce((a, b) => (b.mtime > a.mtime ? b : a)).file : null;
}

/** Ensure drafts/ exists and is self-ignoring, so nothing here is ever committed. */
function ensureDrafts(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
}

/* The consolidation watermark: the newest transcript mtime we have already
 * harvested. It is what keeps SessionStart fast in the common case (a clean
 * exit already consolidated its own transcript and advanced this) and what
 * bounds the catch-up to only sessions that were actually missed. */
const WATERMARK = '.consolidated';
function readWatermark(dir: string): number | null {
  try {
    const v = Number(fs.readFileSync(path.join(dir, WATERMARK), 'utf8').trim());
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}
function writeWatermark(dir: string, ms: number): void {
  try {
    ensureDrafts(dir);
    fs.writeFileSync(path.join(dir, WATERMARK), String(Math.floor(ms)) + '\n');
  } catch {
    /* the watermark is an optimisation; losing it costs a re-parse, never correctness */
  }
}

/**
 * A session's subagent transcripts, if any. Claude Code writes them to
 * `<projects>/<proj>/<session>/subagents/*.jsonl` — where MOST external tool use
 * now lives (a session that delegates research hands every WebSearch/WebFetch/mcp
 * call to a subagent). They finish BEFORE the parent's final write, so their
 * mtime is behind the parent's; once the SessionEnd hook advances the watermark
 * to the parent's mtime they are `<= watermark` and skipped forever. So the hook
 * must sweep them in the same pass — see runHook. (The --surface catch-up already
 * sees them: allTranscripts walks recursively, so a crashed session's subagents,
 * never watermarked, are picked up on their own mtime.)
 */
function subagentTranscripts(transcriptPath: string): string[] {
  try {
    const dir = path.join(path.dirname(transcriptPath), path.basename(transcriptPath, '.jsonl'), 'subagents');
    return fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')).map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

/** Consolidate one transcript into drafts/. Idempotent by content hash. */
function consolidateFile(dir: string, file: string): number {
  try {
    const candidates = detectCandidates(parseTranscript(fs.readFileSync(file, 'utf8')));
    for (const c of candidates) writeCandidate(dir, c, file);
    return candidates.length;
  } catch {
    return 0;
  }
}

/**
 * SessionEnd: harvest the transcript that just closed, immediately, while it is
 * fresh, advance the watermark so the next SessionStart need not re-parse it —
 * and then PROMOTE: run the consolidation pass over the queue, so what this
 * session hit is served to the next one with nobody typing anything. Best-effort
 * by nature — a Ctrl-C or a crash may skip it entirely, which is exactly why
 * SessionStart also catches up. Never throws, always exits 0.
 */
async function runHook(): Promise<void> {
  try {
    const { transcript_path } = hookInput();
    const dir = draftsDir();
    if (!transcript_path || !dir || !fs.existsSync(transcript_path)) return;
    let n = consolidateFile(dir, transcript_path);
    // Sweep this session's subagent transcripts BEFORE the watermark advances
    // past them — that is where most external tool use lives (R2). They are
    // consolidated here, not left to --surface, precisely because advancing the
    // watermark to the parent's mtime would hide them from --surface forever.
    for (const sub of subagentTranscripts(transcript_path)) n += consolidateFile(dir, sub);
    try {
      writeWatermark(dir, Math.max(readWatermark(dir) ?? 0, fs.statSync(transcript_path).mtimeMs));
    } catch {
      /* mtime unreadable; the next SessionStart re-parses this one, idempotently */
    }
    if (n) process.stderr.write(`cairn:sleep harvested ${n} candidate(s) into ${dir}\n`);
    /* The promotion pass, over everything pending — this session's harvest and
     * anything an earlier pass deferred. Its own guards decide whether it runs
     * (off by env, or the live gate owns the queue) and it never throws. */
    const r = await consolidate(dir);
    if (!r.skippedBecause) process.stderr.write(`cairn:sleep ${describe(r).split('\n')[0]}\n`);
  } catch {
    /* a consolidation pass must never be the reason a session failed to end */
  }
  process.exit(0);
}

/**
 * The promotion pass alone, over whatever is pending. Spawned detached by
 * cairn:triage-trigger (session start, and every daemon tick) and available by
 * hand; the harvest is not repeated. Exits 0 whatever happens — its callers are
 * hooks and a daemon, neither of which may be broken by it.
 */
async function runConsolidate(): Promise<void> {
  try {
    const dir = draftsDir();
    if (!dir) return;
    const r = await consolidate(dir);
    const line = describe(r);
    if (HOOK_QUIET) { if (!r.skippedBecause) process.stderr.write(`cairn:sleep ${line}\n`); }
    else console.log(`\ncairn:sleep --consolidate — ${line}\n`);
  } catch (e) {
    process.stderr.write(`cairn:sleep --consolidate failed (ignored): ${(e as Error).message}\n`);
  }
  process.exit(0);
}

/**
 * SessionStart: FIRST catch up on any transcript newer than the watermark — the
 * sessions a missed SessionEnd never consolidated — then report what is waiting.
 * This is the crash-safety net: SessionEnd is best-effort, but every transcript
 * is on disk, so the next session sweeps up whatever was skipped. stdout here
 * becomes context, so the report is the line that points a blank agent at drafts.
 *
 * The current session's own transcript is excluded (it is mid-write and near
 * empty; its own end or the next start will get it), and the very first run after
 * install adopts "now" as the baseline rather than back-scanning a machine's
 * whole transcript history at a latency-sensitive moment. Never throws.
 */
function runSurface(): void {
  try {
    const dir = draftsDir();
    if (!dir) return;
    const { transcript_path } = hookInput();
    const prior = readWatermark(dir);
    if (prior === null) {
      writeWatermark(dir, Date.now());
    } else {
      let maxSeen = prior;
      for (const { file, mtime } of allTranscripts()) {
        if (mtime <= prior) continue;
        if (transcript_path && path.resolve(file) === path.resolve(transcript_path)) continue;
        consolidateFile(dir, file);
        if (mtime > maxSeen) maxSeen = mtime;
      }
      if (maxSeen > prior) writeWatermark(dir, maxSeen);
    }
    /* First, what sleep PROMOTED since anyone last looked — the loop closing,
     * said out loud once: these are now served findings, unverified, and the
     * agent that reads this is the one that can observe them. */
    const report = takeReport(dir);
    if (report?.promoted.length) {
      process.stdout.write(
        `Cairn: sleep consolidated ${report.promoted.length} finding(s) from earlier sessions — unverified, ` +
          `standing decays until observed (cairn_observe when you next see the trap, or cairn:verify):\n` +
          report.promoted.map((p) => `  ${p.id}  ${p.title}`).join('\n') + '\n',
      );
    }
    /* Same rule as pendingCandidates: a dotfile (.triage-scores.json, the
     * report just taken) is bookkeeping and a note-* is the human note tier. */
    const drafts = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.json') && !n.startsWith('.') && !n.startsWith('note-')) : [];
    if (!drafts.length) return;
    process.stdout.write(
      `Cairn: ${drafts.length} harvested candidate(s) from prior sessions are waiting in ${dir} — ` +
        'surprise gaps from earlier transcripts, not yet findings. Sleep consolidates them itself (at session end, ' +
        'and on every daemon tick); nothing is required of you. /cairn queue shows the queue and what was promoted.\n',
    );
  } catch {
    /* surfacing is a convenience; never let it disrupt a session opening */
  }
  process.exit(0);
}

function draftFor(c: Candidate, source: string): Record<string, unknown> {
  return {
    _kind: 'sleep-candidate',
    _note: 'Harvested from a transcript by cairn:sleep. Not a finding yet: the consolidation pass promotes it (unverified) if it clears the automatic gate, or settles it with a reason. A person may still complete it by hand with cairn_record.',
    source,
    tool: c.tool,
    surprisal: c.surprisal,
    why: c.reasons,
    /* The three fields come straight from the trace: the agent's own words. */
    expectation: c.expectation || '(none stated before the call)',
    reality: c.reality,
    mechanism_or_update: c.update || '(no model-update text found after the result)',
    evidence: [
      { command: `${c.tool} ${JSON.stringify(c.input)}`, output: c.reality },
    ],
  };
}

async function main() {
  if (HOOK) return runHook();
  if (SURFACE) return runSurface();
  if (CONSOLIDATE) return runConsolidate();

  const homeIdx = argv.indexOf('--home');
  const homeValIdx = homeIdx !== -1 ? homeIdx + 1 : -1;
  const files = argv.filter((a, i) => !a.startsWith('--') && i !== homeValIdx);
  if (argv.includes('--latest')) {
    const t = latestTranscript();
    if (!t) {
      console.error('cairn:sleep: no transcript found under ~/.claude/projects');
      process.exit(1);
    }
    files.push(t);
  }
  if (!files.length) {
    console.error('usage: npm run cairn:sleep -- <transcript.jsonl> [...]  |  --latest  [--print]  |  --consolidate');
    process.exit(2);
  }

  let dir: string | null = null;
  try {
    dir = homePath('drafts');
  } catch {
    /* no corpus home resolvable; --print still works, writing does not */
  }

  console.log('\ncairn:sleep — consolidating what the trace already says');
  console.log('='.repeat(60));

  let total = 0;
  for (const file of files) {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
      console.error(`  skip ${file}: ${(e as Error).message}`);
      continue;
    }
    const turns = parseTranscript(raw);
    const candidates = detectCandidates(turns);
    console.log(`\n  ${path.basename(file)} — ${turns.length} turns, ${candidates.length} surprise gap(s)`);

    for (const c of candidates) {
      total++;
      console.log(`    [${c.surprisal}] ${c.tool}  — ${c.reasons.join('; ')}`);
      if (c.update) console.log(`         update: ${c.update.replace(/\s+/g, ' ').slice(0, 100)}`);
      if (PRINT || !dir) continue;
      writeCandidate(dir, c, file);
    }
  }

  console.log('\n' + '='.repeat(60));
  if (PRINT || !dir) {
    console.log(`${total} candidate(s). Nothing written${dir ? ' (--print)' : ' (no corpus home)'}.`);
  } else {
    console.log(`${total} candidate(s) written to ${dir} — provisional, not findings.`);
    const r = await consolidate(dir);
    console.log(describe(r));
  }
  console.log();
}

void main();
