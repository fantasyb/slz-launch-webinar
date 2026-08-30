/**
 * Pre-commit gate. Nothing sensitive enters git history, and nothing
 * executable-and-hostile enters the corpus.
 *
 * This is the right place for the check because it is the last moment before
 * a leak becomes permanent and public, and because it costs the contributor
 * nothing until it fires. Asking a person to adjudicate a list of warnings on
 * every draft guarantees they contribute once; a gate that is silent until it
 * matters is one they keep.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import { scanSensitive, scanExecutable, redact } from '../src/lib/cairn/safety';

/**
 * Fields whose contents are cryptographic material by design. Scanning them as
 * prose flags every signature as an opaque blob, which is a false positive that
 * would train a contributor to pass --no-verify — the worst possible outcome
 * for a gate whose only job is to be trusted when it fires.
 */
const CRYPTO_FIELDS = new Set(['value', 'hash', 'nonce', 'publicKey', 'anchor', 'keyId']);

/** Text a JSON file actually contributes, excluding crypto material. */
function proseOf(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text; // not JSON after all; scan it whole
  }
  const parts: string[] = [];
  const walk = (v: unknown, key?: string) => {
    if (key && CRYPTO_FIELDS.has(key)) return;
    if (typeof v === 'string') parts.push(v);
    else if (Array.isArray(v)) v.forEach((x) => walk(x));
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) walk(x, k);
    }
  };
  walk(parsed);
  return parts.join('\n');
}

// -z, so a filename containing a newline or a non-ASCII byte arrives intact.
// Without it git C-quotes such paths, `fs.existsSync` returned false, and they
// were dropped from the scan without a word.
const staged = execFileSync(
  'git',
  ['diff', '--cached', '--name-only', '--diff-filter=ACM', '-z'],
  { encoding: 'utf8' },
)
  .split('\0')
  .filter(Boolean);

const PATTERN_FIXTURES = [
  'src/lib/cairn/safety.ts',
  'test/safety.test.ts',
  'cairn/0014-follow-this-url-is-standing-rce.json',
];

let blocked = 0;

// A private key or a sealed preimage should never be in a commit, and the
// old filter exempted exactly the directory holding them: `.cairn-secrets` is
// gitignored, so it was assumed unreachable, but `git add -f` reaches it. The
// gate built to keep private keys out of history had a hole shaped like the
// private keys.
for (const file of staged) {
  if (file.startsWith('.cairn-secrets/') || file.startsWith('.cairn-secrets')) {
    console.error(`BLOCKED ${file}`);
    console.error('  .cairn-secrets holds private keys and unrevealed forecast preimages.');
    console.error('  Nothing in it may be committed. Unstage it: git restore --staged ' + file);
    blocked++;
    continue;
  }
  if (file.startsWith('.cairn-')) continue;

  // Read what is STAGED, not what is on disk. The two differ whenever a file
  // was edited after `git add`, so staging a token and then deleting it from
  // the worktree let the token through the gate and into the commit.
  let raw: string;
  try {
    raw = execFileSync('git', ['show', `:${file}`], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    continue; // not resolvable in the index (submodule, or a race) — nothing to scan
  }
  const text = file.endsWith('.json') ? proseOf(raw) : raw;

  // Secrets: never, in any file.
  for (const flag of scanSensitive(text)) {
    // Named one by one, never by directory. These files exist to contain
    // examples of the patterns -- the detector itself, its tests, and the
    // corpus entry documenting them -- so the scan would block every change to
    // them. Exempting `test/` wholesale instead would mean a real credential
    // pasted into any future test file walks straight through the gate.
    if (PATTERN_FIXTURES.some((f) => file === f)) continue;
    console.error(`BLOCKED ${file}`);
    console.error(`  ${flag.pattern}: ${flag.reason}`);
    console.error(`  ${flag.sample}`);
    const suggestion = redact(flag.sample).text;
    if (suggestion !== flag.sample) console.error(`  suggested: ${suggestion}`);
    blocked++;
  }

  // Dangerous commands: only enforced inside the corpus, which agents execute.
  if (file.startsWith('cairn/') && file.endsWith('.json')) {
    for (const flag of scanExecutable(raw).filter((f) => f.severity === 'block')) {
      console.error(`BLOCKED ${file}`);
      console.error(`  ${flag.pattern}: ${flag.reason}`);
      console.error(`  ${flag.sample}`);
      blocked++;
    }
  }
}

if (blocked) {
  console.error(`\n${blocked} problem(s). Nothing committed.`);
  console.error('Redact and re-stage, or run: npm run cairn:draft -- <file> --fix');
  console.error('Override only if you are certain: git commit --no-verify');
  process.exit(1);
}
