/**
 * cairn:spec — the finding format as JSON Schema, generated from the one
 * definition the code enforces.
 *
 *   npm run cairn:spec            # write spec/finding.schema.json
 *   npm run cairn:spec -- --check # exit 1 if the committed file has drifted
 *
 * The zod schema in src/lib/cairn/schema.ts is what every loader validates
 * against, so it is the specification, and a hand-written copy would drift
 * from it the way the prose docs drifted from the code. This emits it. The
 * check runs in the test suite, so the committed schema cannot fall behind
 * the code without a red build.
 *
 * Anyone can validate a finding with this file and nothing else from this
 * repository -- no ranker, no gateway. The runtime half of the format, the
 * gate that proves a check decides something, is `cairn:conform --run`.
 */
import fs from 'fs';
import path from 'path';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { FindingSchema } from '../src/lib/cairn/schema';

const OUT = path.join(process.cwd(), 'spec', 'finding.schema.json');
const schema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://cairny.io/spec/finding.schema.json',
  title: 'Cairn finding',
  description:
    'A claim that something does not work, carrying the command that would refute it (check), ' +
    'a half-life after which it decays, and the provenance of every observation. Generated from ' +
    'src/lib/cairn/schema.ts by npm run cairn:spec; do not edit by hand.',
  ...zodToJsonSchema(FindingSchema, { name: 'Finding', $refStrategy: 'none' }),
};
const text = `${JSON.stringify(schema, null, 2)}\n`;

if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (current !== text) {
    console.error('spec/finding.schema.json is out of date with src/lib/cairn/schema.ts — run npm run cairn:spec');
    process.exit(1);
  }
  console.log('spec/finding.schema.json is current');
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, text);
  console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
}
