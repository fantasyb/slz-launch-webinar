/**
 * Where this corpus lives, which is not necessarily where you are standing.
 *
 * Every path in this project was resolved against process.cwd(), which is
 * correct exactly while the only caller is a script run from the repository
 * root. Run the CLI from another project — the entire point of the thing — and
 * `cairn/` does not exist there, `loadCorpus` returns an empty array, and the
 * answer is:
 *
 *     nothing in the corpus matches "curl exit 56 CONNECT tunnel failed"
 *
 * which is a sentence about the corpus that is false. It did not fail to match.
 * It failed to load, and then reported the result as knowledge. A user trying
 * this on their own project would reasonably conclude the ledger is empty.
 *
 * Resolution order, most explicit first:
 *   1. CAIRN_HOME, for a host that knows where it put things
 *   2. the package root, derived from this file — correct when the CLI is
 *      invoked by absolute path from anywhere
 *   3. the working directory, which is what it always did
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/** Walk up from a starting point looking for a directory that IS the install. */
function ascendToRoot(from: string): string | null {
  let dir = from;
  for (let up = 0; up < 6; up++) {
    if (fs.existsSync(path.join(dir, 'cairn')) && fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/*
 * argv[1] FIRST, and that ordering is the whole fix.
 *
 * import.meta.url is undefined in the CommonJS bundle that `cairn:build-cli`
 * produces, which is precisely the artefact a user on another project runs. So
 * the module-relative lookup silently returned null exactly where it was
 * needed, fell through to the working directory, and reported an empty corpus
 * as an empty answer. The path of the script being executed is available under
 * both module systems.
 */
function packageRoot(): string | null {
  const entry = process.argv[1];
  if (entry) {
    const found = ascendToRoot(path.dirname(path.resolve(entry)));
    if (found) return found;
  }
  try {
    return ascendToRoot(path.dirname(fileURLToPath(import.meta.url)));
  } catch {
    return null;
  }
}

let memo: string | null = null;
export function cairnHome(): string {
  if (memo) return memo;
  /*
   * An explicit setting that turns out to be wrong FAILS. It used to fall
   * through to the next candidate, which meant CAIRN_HOME=/wrong/path answered
   * from a different corpus without saying so — the setting was obeyed only
   * while it was already correct. A configuration that is silently ignored is
   * worse than one that is unsupported.
   */
  const explicit = process.env.CAIRN_HOME;
  if (explicit) {
    if (!fs.existsSync(path.join(explicit, 'cairn'))) {
      throw new Error(
        `CAIRN_HOME is set to ${explicit}, which has no cairn/ directory. ` +
          'Point it at a corpus checkout, or unset it.',
      );
    }
    return (memo = explicit);
  }
  const root = packageRoot();
  if (root) return (memo = root);
  return (memo = process.cwd());
}

/** A path inside the corpus install. */
export function homePath(...parts: string[]): string {
  return path.join(cairnHome(), ...parts);
}

/**
 * True when there is actually a corpus where we are looking. Callers that
 * report emptiness to a human should say WHICH emptiness this is.
 */
export function corpusPresent(): boolean {
  try {
    return fs.readdirSync(homePath('cairn')).some((f) => f.endsWith('.json'));
  } catch {
    return false;
  }
}
