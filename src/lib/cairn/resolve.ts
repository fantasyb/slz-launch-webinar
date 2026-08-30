import fs from 'fs';
import path from 'path';

const FINDING_ID = /^cairn-\d{4}$/;

/**
 * Map a finding id to exactly one file, or fail.
 *
 * The scripts used to do this with
 * `readdirSync(DIR).find(f => f.includes(id.replace('cairn-', '')))`: first
 * entry whose name merely *contains* the digits, no `.json` filter, no
 * ambiguity check. `predict` and `reveal` then *wrote* to whatever came back.
 * An editor backup `0003-foo.json.bak` shadowed the real finding, `cairn-001`
 * resolved to something rather than erroring, and a bare `1` matched whichever
 * file sorted first.
 *
 * Resolution is by the id inside the file, not by its name, so renaming a
 * finding file cannot silently retarget a write.
 */
export function resolveFindingFile(id: string, dir = path.join(process.cwd(), 'cairn')): string {
  if (!FINDING_ID.test(id)) {
    throw new Error(`"${id}" is not a finding id (expected cairn-NNNN)`);
  }
  const matches = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.join(dir, f))
    .filter((full) => {
      try {
        return JSON.parse(fs.readFileSync(full, 'utf8'))?.id === id;
      } catch {
        return false; // unparseable files are lint's problem, not resolution's
      }
    });

  if (matches.length === 0) throw new Error(`no finding ${id} in ${dir}`);
  if (matches.length > 1) {
    throw new Error(
      `${id} appears in ${matches.length} files: ${matches.map((m) => path.basename(m)).join(', ')}`,
    );
  }
  return matches[0];
}
