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
import { execSync } from 'child_process';
import fs from 'fs';
import { scanSensitive, scanExecutable, redact } from '../src/lib/cairn/safety';

const staged = execSync('git diff --cached --name-only --diff-filter=ACM', { encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && fs.existsSync(f) && !f.startsWith('.cairn-'));

let blocked = 0;

for (const file of staged) {
  const text = fs.readFileSync(file, 'utf8');

  // Secrets: never, in any file.
  for (const flag of scanSensitive(text)) {
    // safety.ts and the corpus entry that documents these patterns necessarily
    // contain examples of them.
    if (file.endsWith('safety.ts') || file.includes('0014-')) continue;
    console.error(`BLOCKED ${file}`);
    console.error(`  ${flag.pattern}: ${flag.reason}`);
    console.error(`  ${flag.sample}`);
    const suggestion = redact(flag.sample).text;
    if (suggestion !== flag.sample) console.error(`  suggested: ${suggestion}`);
    blocked++;
  }

  // Dangerous commands: only enforced inside the corpus, which agents execute.
  if (file.startsWith('cairn/') && file.endsWith('.json')) {
    for (const flag of scanExecutable(text).filter((f) => f.severity === 'block')) {
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
