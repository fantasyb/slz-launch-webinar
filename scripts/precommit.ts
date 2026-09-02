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
const CRYPTO_FIELDS = new Set(['value', 'hash', 'nonce', 'publicKey', 'anchor', 'keyId', 'signature']);

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
  /*
   * R, for renamed, and it was missing.
   *
   * A rename that also edits the file is reported as R, not M, so
   * --diff-filter=ACM skipped it entirely: `git mv` a large file, append a
   * credential, and the gate returns clean. Reproduced at R099 -- ninety-nine
   * percent similar, one added line holding a session id, exit 0. A
   * forty-seven file refactor moving code between directories is exactly the
   * commit that produces renames, and exactly the commit nobody reads closely.
   */
  ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'],
  { encoding: 'utf8' },
)
  .split('\0')
  .filter(Boolean);

const PATTERN_FIXTURES = [
  'src/lib/cairn/safety.ts',
  'test/safety.test.ts',
  // Proves a refused secret comes back with its redaction, which needs a secret-shaped string to refuse.
  'test/record.test.ts',
  'cairn/0014-follow-this-url-is-standing-rce.json',
  /* Asserts what the execution policy does with a credential-shaped value. */
  'test/policy.test.ts',
  /*
   * A harvest fixture: a small fake codebase that is supposed to look like a
   * real one, internal hostname included. Named individually rather than
   * exempting research/fixtures/, so the next fixture added there has to
   * justify itself the same way.
   */
  'research/fixtures/harvest/zod/src/client.ts',
];

/**
 * Machine-generated dependency lockfiles.
 *
 * Not an exemption for convenience -- these files are structurally guaranteed
 * to trip two of the detectors and structurally incapable of carrying the
 * thing they exist to catch. Every entry has a base64 subresource integrity
 * hash, which reads as an opaque blob, and any dependency whose major version
 * is ten produces a dotted string the private-address pattern matches. Neither
 * is a secret, and a lockfile is written
 * by the package manager rather than by a person, so nothing sensitive can be
 * typed into one.
 *
 * The alternative was `git commit --no-verify`, which disables every check
 * including the ones that matter, in a repository whose signing keys live one
 * directory away. A narrow, named, argued exemption beats a habit of stepping
 * over the gate -- and cairn-0028 is what happens when a gate is bypassed
 * often enough that nobody notices it stopped applying.
 *
 * Still scanned for the .cairn-secrets rule above, which runs before this.
 */
const GENERATED_LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
]);

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
  if (GENERATED_LOCKFILES.has(file)) continue;

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
  /*
   * .jsonl as well as .json, one object per line.
   *
   * Trial transcripts are JSONL, and every assistant turn carries a
   * `signature` -- base64 by construction, and structurally indistinguishable
   * from an encoded secret. Scanned as prose, all thirty-four committed
   * transcripts trip opaque-blob, and so would every transcript of every
   * future run. That is the gate firing on its own correct output at the
   * moment somebody is committing an experiment's results, and the way out
   * that presents itself is --no-verify, which switches off the secret scan
   * too. A gate that has to be bypassed to do ordinary work is worse than no
   * gate, because it teaches the bypass.
   */
  const text = file.endsWith('.json')
    ? proseOf(raw)
    : file.endsWith('.jsonl')
      ? raw.split('\n').filter(Boolean).map(proseOf).join('\n')
      : raw;

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
