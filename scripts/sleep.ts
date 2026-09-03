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
import { homePath } from '../src/lib/cairn/home';
import { parseTranscript, detectCandidates, type Candidate } from '../src/lib/cairn/sleep';

const argv = process.argv.slice(2);
const PRINT = argv.includes('--print') || argv.includes('--dry-run');

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
  const files = argv.filter((a) => !a.startsWith('--'));
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
      fs.mkdirSync(dir, { recursive: true });
      const ignore = path.join(dir, '.gitignore');
      if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
      const name = `sleep-${path.basename(file, '.jsonl')}-${c.tool.replace(/[^A-Za-z0-9_.-]+/g, '_')}-${c.surprisal}.json`;
      fs.writeFileSync(path.join(dir, name), JSON.stringify(draftFor(c, path.basename(file)), null, 2) + '\n');
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
