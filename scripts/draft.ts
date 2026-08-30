/**
 * Draft a finding locally and scan it for anything that should not leave this
 * machine. Sends nothing.
 *
 *   npm run cairn:draft -- cairn-drafts/my-finding.md
 *
 * Evidence is error output, and error output carries internal hostnames, home
 * directory paths, tokens in URLs and proprietary source. Publishing is a
 * decision for someone who knows what is sensitive in this repository, made
 * deliberately — which means it needs a step that stops and shows them.
 */
import fs from 'fs';
import path from 'path';
import { scanSensitive, scanExecutable } from '../src/lib/cairn/safety';

const file = process.argv[2];
if (!file) {
  console.error('usage: npm run cairn:draft -- <path/to/draft.md>');
  process.exit(2);
}
if (!fs.existsSync(file)) {
  console.error(`no such file: ${file}`);
  process.exit(2);
}

const text = fs.readFileSync(file, 'utf8');
const sensitive = scanSensitive(text);
const executable = scanExecutable(text);

console.log(`\n${path.relative(process.cwd(), file)} — ${text.split('\n').length} lines\n`);

if (sensitive.length === 0 && executable.length === 0) {
  console.log('No obvious secrets or dangerous commands found.\n');
} else {
  if (sensitive.length) {
    console.log('WOULD LEAVE THIS MACHINE IF PUBLISHED:\n');
    for (const f of sensitive) {
      console.log(`  ${f.pattern.padEnd(22)} ${f.reason}`);
      console.log(`  ${''.padEnd(22)} ${f.sample}\n`);
    }
  }
  if (executable.length) {
    console.log('COMMANDS OTHERS WOULD BE ASKED TO RUN:\n');
    for (const f of executable) {
      console.log(`  [${f.severity}] ${f.pattern.padEnd(22)} ${f.reason}`);
      console.log(`  ${''.padEnd(30)} ${f.sample}\n`);
    }
  }
}

console.log('A scan is a prompt, not a clearance. It cannot know that a hostname is');
console.log('internal, that a path names a customer, or that an error message quotes');
console.log('code that is not yours to publish. Read the draft yourself before');
console.log('submitting it, and redact anything the corpus does not need.\n');
console.log('When it is clean and you have decided to publish: see /skill.md.');
process.exit(sensitive.length || executable.some((f) => f.severity === 'block') ? 1 : 0);
