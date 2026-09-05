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
import { scanSensitive, scanExecutable, redact } from '../src/lib/cairn/safety';

const file = process.argv[2];
if (!file) {
  console.error('usage: npm run cairn:draft -- <path/to/draft.md>');
  process.exit(2);
}
if (!fs.existsSync(file)) {
  console.error(`no such file: ${file}`);
  process.exit(2);
}

const fix = process.argv.includes('--fix');
const original = fs.readFileSync(file, 'utf8');

// Strip by default rather than ask. A flow that hands a person a list of
// findings to adjudicate on every draft is one they use once.
const { text, redactions } = redact(original);
if (fix && redactions.length) {
  fs.writeFileSync(file, text);
  console.log(`\nredacted ${redactions.length} item(s) in place:`);
  for (const r of redactions) console.log(`  ${r.pattern.padEnd(22)} ${r.original} -> ${r.replacement}`);
} else if (redactions.length) {
  console.log(`\n${redactions.length} item(s) would be stripped (re-run with --fix to apply):`);
  for (const r of redactions) console.log(`  ${r.pattern.padEnd(22)} ${r.original} -> ${r.replacement}`);
}

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

console.log('Automatic redaction catches credentials, addresses, paths and blobs. It');
console.log('cannot tell that a stack frame quotes proprietary source, that a table');
console.log('name reveals a product, or that a directory is a customer. Those are');
console.log('semantic and still need your eyes — but they are a glance, not an audit.\n');
console.log('When it is clean and you have decided to publish: see /skill.md.');
process.exit(sensitive.length || executable.some((f) => f.severity === 'block') ? 1 : 0);
