/**
 * Auto-mount — when you are working in a repo that has its own corpus
 * (<repo>/.cairn), read it ALONGSIDE the machine corpus, automatically, with no
 * config and no CAIRN_HOME juggling.
 *
 * THE MODEL. The machine corpus stays primary: it holds the tool and environment
 * traps that apply everywhere, so a session must never lose them just because it
 * is inside a project. The project corpus is mounted as an ADDITIONAL read source
 * — its findings appear in find/brief namespaced by its own unique origin
 * (<origin>:cairn-0001), so the two can never be confused (corpusOrigin.ts). Writes
 * still default to the machine corpus; a project-specific finding is the explicit
 * case, recorded with CAIRN_HOME pointed at the project.
 *
 * Detection is by the working directory: the MCP server's cwd is the project it
 * was launched in, and a CLI is run from the project too, so a `.cairn/` in the
 * cwd or an ancestor is the project you are in. Reading is LIVE (straight off the
 * directory), not a cached bundle — a project corpus is your own, on your own
 * disk, and there is no reason to stale it through a snapshot.
 *
 * Kept free of any import from federation.ts so federation.ts can call this
 * without a cycle; the SearchableFinding tagging happens there.
 */
import fs from 'fs';
import path from 'path';
import { FindingSchema, type Finding } from './schema';
import { deriveKeyId, type KeyRecord } from './signing';
import { cairnHome } from './home';

/**
 * The project corpus for the given directory: the nearest `.cairn` (containing a
 * cairn/ dir) at or above `cwd`, or null. Never returns the primary corpus — if
 * the primary home IS this project's .cairn, it is already loaded as local and
 * must not be mounted twice.
 */
export function projectCorpusHome(cwd: string = process.cwd()): string | null {
  let primary: string | null = null;
  try {
    primary = path.resolve(cairnHome());
  } catch {
    /* primary unresolved (misconfigured); still fine to detect a project one */
  }
  let dir = path.resolve(cwd);
  for (let up = 0; up < 8; up++) {
    const home = path.join(dir, '.cairn');
    if (fs.existsSync(path.join(home, 'cairn'))) {
      if (primary && path.resolve(home) === primary) return null; // already the primary
      return home;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Read a corpus home's public keys into a map, skipping any that don't self-verify. */
function loadKeysFrom(home: string): Map<string, KeyRecord> {
  const keys = new Map<string, KeyRecord>();
  const dir = path.join(home, 'keys');
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return keys;
  }
  for (const name of names) {
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as KeyRecord;
      if (rec.keyId && rec.publicKey && deriveKeyId(rec.publicKey) === rec.keyId) keys.set(rec.keyId, rec);
    } catch {
      /* skip an unreadable or mismatched key */
    }
  }
  return keys;
}

function readOrigin(home: string): string {
  try {
    const o = (JSON.parse(fs.readFileSync(path.join(home, 'cairn.config.json'), 'utf8')) as { origin?: string }).origin;
    if (typeof o === 'string' && o.trim()) return o.trim();
  } catch {
    /* fall through */
  }
  const base = path.basename(home) === '.cairn' ? path.basename(path.dirname(home)) : path.basename(home);
  return base || 'project';
}

export interface MountedCorpus {
  home: string;
  origin: string;
  findings: Finding[];
  keys: Map<string, KeyRecord>;
}

/** Load the auto-mounted project corpus for `cwd`, or null when there isn't one. */
export function loadProjectCorpus(cwd: string = process.cwd()): MountedCorpus | null {
  const home = projectCorpusHome(cwd);
  if (!home) return null;
  const dir = path.join(home, 'cairn');
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return null;
  }
  const findings: Finding[] = [];
  for (const name of names.sort()) {
    try {
      const parsed = FindingSchema.safeParse(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
      if (parsed.success) findings.push(parsed.data);
    } catch {
      /* a malformed project finding is not a reason to lose the rest */
    }
  }
  if (!findings.length) return null;
  return { home, origin: readOrigin(home), findings, keys: loadKeysFrom(home) };
}
