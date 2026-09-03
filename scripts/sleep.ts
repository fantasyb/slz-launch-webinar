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
 * expectation, the tool's actual result, and the agent's own correction — that a
 * person or `cairn_record` turns into a finding with a check, at which point
 * selection (the check, usage, decay) decides whether it survives. Sleep writes
 * nothing to cairn/ and enables no execution.
 *
 * See src/lib/cairn/sleep.ts for why errors are below threshold and a model
 * update or a superset contradiction is what clears the gate (cairn-0045).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { homePath } from '../src/lib/cairn/home';
import { parseTranscript, detectCandidates, type Candidate } from '../src/lib/cairn/sleep';

const argv = process.argv.slice(2);
const PRINT = argv.includes('--print') || argv.includes('--dry-run');
/* Two automatic modes, wired by cairn:install into ~/.claude/settings.json so
 * nobody ever has to type the command — a command nobody types is a command
 * that does not exist. --hook runs at SessionEnd (the offline consolidation
 * pass, over the transcript that just closed); --surface runs at SessionStart
 * (report the candidates a prior session left, so the loop closes). Both read
 * Claude Code's hook JSON on stdin and MUST NOT fail the session: everything is
 * wrapped, and they always exit 0 (cairn-0046 — a hook that throws at startup
 * shows up as a broken session, not a broken hook). */
const HOOK = argv.includes('--hook');
const SURFACE = argv.includes('--surface');

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
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
  const digest = crypto.createHash('sha256').update(`${c.tool}\0${c.expectation}\0${c.reality}\0${c.update}`).digest('hex').slice(0, 10);
  const name = `sleep-${path.basename(source, '.jsonl')}-${c.tool.replace(/[^A-Za-z0-9_.-]+/g, '_')}-${c.surprisal}-${digest}.json`;
  fs.writeFileSync(path.join(dir, name), JSON.stringify(draftFor(c, path.basename(source)), null, 2) + '\n');
}

/**
 * SessionEnd: consolidate the transcript that just closed. Silent by design —
 * this runs as the session ends, with nobody watching; it leaves candidates in
 * drafts/ for the next session to surface. Never throws, always exits 0.
 */
function runHook(): void {
  try {
    const { transcript_path } = hookInput();
    const dir = draftsDir();
    if (!transcript_path || !dir || !fs.existsSync(transcript_path)) return;
    const raw = fs.readFileSync(transcript_path, 'utf8');
    const candidates = detectCandidates(parseTranscript(raw));
    for (const c of candidates) writeCandidate(dir, c, transcript_path);
    /* A one-line breadcrumb to stderr — visible in hook logs, never in context. */
    if (candidates.length) process.stderr.write(`cairn:sleep consolidated ${candidates.length} candidate(s) into ${dir}\n`);
  } catch {
    /* a consolidation pass must never be the reason a session failed to end */
  }
  process.exit(0);
}

/**
 * SessionStart: tell the fresh session what a prior one harvested, so the
 * candidates do not sit unseen. stdout at SessionStart becomes context, so this
 * is the one line that makes a blank agent reach for drafts. Never throws.
 */
function runSurface(): void {
  try {
    const dir = draftsDir();
    if (!dir || !fs.existsSync(dir)) return;
    const drafts = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
    if (!drafts.length) return;
    process.stdout.write(
      `Cairn: ${drafts.length} consolidated candidate(s) from prior sessions are waiting in ${dir} — ` +
        'surprise gaps harvested from earlier transcripts, not yet findings. If any names a real, ' +
        'checkable trap, promote it with cairn_record (add a check); the rest decay unused.\n',
    );
  } catch {
    /* surfacing is a convenience; never let it disrupt a session opening */
  }
  process.exit(0);
}

function latestTranscript(): string | null {
  const root = path.join(os.homedir(), '.claude', 'projects');
  let newest: { file: string; mtime: number } | null = null;
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
        const m = fs.statSync(p).mtimeMs;
        if (!newest || m > newest.mtime) newest = { file: p, mtime: m };
      }
    }
  };
  walk(root);
  return newest ? (newest as { file: string }).file : null;
}

function draftFor(c: Candidate, source: string): Record<string, unknown> {
  return {
    _kind: 'sleep-candidate',
    _note: 'Harvested from a transcript by cairn:sleep. Not a finding until a check is written and it survives selection. Complete with cairn_record.',
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

function main() {
  if (HOOK) return runHook();
  if (SURFACE) return runSurface();

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
    console.error('usage: npm run cairn:sleep -- <transcript.jsonl> [...]  |  --latest  [--print]');
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
    console.log('Complete the ones worth keeping with cairn_record (add a check); the rest decay unused.');
  }
  console.log();
}

main();
