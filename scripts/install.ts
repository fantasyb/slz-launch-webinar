/**
 * Install the Cairn block into a project's agent instruction file — locally,
 * from code you can read, behind a diff you have to approve.
 *
 *   npm run cairn:install -- --into ../my-project --base https://cairn.example
 *   npm run cairn:install -- --into ../my-project --base https://cairn.example --yes
 *
 * This exists because the alternative — "point your agent at a URL and let it
 * edit your files" — hands write access to your repository to whoever controls
 * that host, forever. See cairn-0014.
 *
 * Prints the exact change and refuses to write without --yes.
 */
import fs from 'fs';
import path from 'path';
import { installBlock, BLOCK_BEGIN, INSTRUCTION_FILES } from '../src/lib/cairn/block';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const target = path.resolve(arg('into') ?? process.cwd());
const base = arg('base') ?? 'https://CAIRN_HOST';
const approved = process.argv.includes('--yes');

if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
  console.error(`not a directory: ${target}`);
  process.exit(2);
}

const existing = INSTRUCTION_FILES.map((f) => path.join(target, f)).find((f) => fs.existsSync(f));
const file = existing ?? path.join(target, INSTRUCTION_FILES[0]);
const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';

if (current.includes(BLOCK_BEGIN)) {
  console.log(`already installed in ${path.relative(process.cwd(), file)} — nothing to do`);
  process.exit(0);
}

const block = installBlock(base);
const next = current.trimEnd() ? `${current.trimEnd()}\n\n${block}\n` : `${block}\n`;

console.log(`\ntarget    ${file}${existing ? '' : '   (will be created)'}`);
console.log(`base url  ${base}`);
console.log(`\nThis appends ${block.split('\n').length} lines. Nothing else in the file changes.\n`);
console.log('─'.repeat(72));
for (const line of block.split('\n')) console.log(`+ ${line}`);
console.log('─'.repeat(72));

if (base.includes('CAIRN_HOST')) {
  console.log('\nNote: no --base given, so the block points at a placeholder host.');
}

if (!approved) {
  console.log('\nRead the block above. If it is what you want, re-run with --yes.');
  console.log('Nothing has been written.');
  process.exit(0);
}

fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, next);
console.log(`\nwrote ${path.relative(process.cwd(), file)}`);
console.log('To uninstall, delete everything between the cairn:begin and cairn:end markers.');
