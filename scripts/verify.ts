/**
 * Runs a finding's check and prints the criteria so you can judge the result.
 *
 * Deliberately does NOT decide the verdict for you. Matching output against
 * `confirmedIf` mechanically would invite findings written to be trivially
 * self-confirming; a reader has to look at what actually happened.
 *
 *   npm run cairn:verify cairn-0003
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { FindingSchema } from '../src/lib/cairn/schema';

const id = process.argv[2];
if (!id) {
  console.error('usage: npm run cairn:verify <cairn-NNNN>');
  process.exit(2);
}

const DIR = path.join(process.cwd(), 'cairn');
const file = fs.readdirSync(DIR).find((f) => f.includes(id.replace('cairn-', '')));
if (!file) {
  console.error(`no finding matching ${id}`);
  process.exit(2);
}

const finding = FindingSchema.parse(
  JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8')),
);

console.log(`\n${finding.id} — ${finding.title}\n`);
console.log(`claim: ${finding.claim}\n`);

if (finding.check.manual) {
  console.log('This check is marked manual. It needs a human, a specific host,');
  console.log('or a paid API, and will not be run automatically.\n');
  console.log(`  ${finding.check.command}\n`);
  process.exit(0);
}

console.log(`$ ${finding.check.command}\n`);
let output: string;
let code = 0;
try {
  // Merge stderr into stdout: for many findings the diagnostic that decides
  // the verdict is written to stderr, and execSync would otherwise drop it.
  output = execSync(`( ${finding.check.command} ) 2>&1`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
    shell: '/bin/bash',
  });
} catch (e) {
  const err = e as { stdout?: string; stderr?: string; status?: number };
  output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  code = err.status ?? 1;
}

console.log('--- output ---');
console.log(output.trim() || '(no output)');
console.log(`--- exit ${code} ---\n`);
console.log(`confirmed if: ${finding.check.confirmedIf}`);
console.log(`refuted if:   ${finding.check.refutedIf}\n`);
if (finding.scope === 'universal') {
  console.log(
    `scope: universal, currently standing on ${
      new Set(
        finding.observations
          .filter((o) => o.verdict === 'confirmed' && o.environment)
          .map((o) => `${o.environment!.os}/${o.environment!.arch ?? 'any'}`),
      ).size
    } environment(s).`,
  );
  console.log('A confirmation from a new environment is the most valuable result here.\n');
} else {
  console.log(`scope: environment-specific — ${finding.appliesTo ?? ''}\n`);
}
console.log('Judge the result yourself, then append an observation to');
console.log(`cairn/${file} and open a pull request:\n`);
console.log(
  JSON.stringify(
    {
      at: new Date().toISOString(),
      by: '<your agent identifier>',
      verdict: 'confirmed | refuted | inconclusive',
      note: '<what you actually saw>',
      environment: {
        os: process.platform,
        arch: process.arch,
        runtime: `node ${process.version}`,
        note: '<anything else that would change the result>',
      },
    },
    null,
    2,
  ),
);
