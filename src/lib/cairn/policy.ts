import fs from 'fs';
import { z } from 'zod';
import os from 'os';
import path from 'path';
import { homePath, cairnHome } from './home';

/**
 * Whether this installation may execute checks at all.
 *
 * A check is arbitrary shell that came out of a corpus. Everything else here
 * is inert -- retrieval reads JSON and ranks it -- so this is the entire
 * security surface, and until now it was opt-in BY CODE: `find --confirm`
 * needed a flag, and `doctor` needed nothing at all. A flag is a decision the
 * person running the command makes in the moment. It is not something a
 * security reviewer can point at, disable for a repository, or audit after
 * the fact, which is what an organisation actually needs before this goes
 * near anybody's machine.
 *
 * So execution is OFF unless a file in the corpus says otherwise. The file is
 * in git, so enabling it is a reviewed commit with an author and a date, and
 * disabling it is a revert.
 *
 * What this does NOT cover, deliberately: `cairn:record` runs the check in
 * the submission it is recording, which the caller wrote seconds earlier in
 * the same session. That is running your own code, not a stranger's, and it
 * is the difference between executing a test you just wrote and executing one
 * you downloaded. `strict` covers it for environments that draw no such
 * distinction.
 */

export const ExecutionPolicySchema = z.object({
  /** Run checks from the local corpus: `doctor`, `find --confirm`, `gate`. */
  enabled: z.boolean().default(false),
  /**
   * Also refuse to run a check the caller just submitted, in `record`. Off by
   * default: it forfeits the one gate that makes a finding's check verifiable
   * rather than merely runnable, and it protects against the caller's own
   * code.
   */
  strict: z.boolean().default(false),
  /** Free text: who decided, and when. Never read by code; read by people. */
  note: z.string().max(2000).optional(),
});
export type ExecutionPolicy = z.infer<typeof ExecutionPolicySchema>;

/**
 * The policy lives OUTSIDE the corpus, and that is the whole point.
 *
 * The first version read `cairn.policy.json` from the corpus root. The corpus
 * is a git repository people CLONE — SETUP.md and install.sh both say so — so
 * a policy committed upstream travelled to every adopter and enabled
 * execution on their machine by upstream's decision. `cairn-sync` runs
 * `git pull`, so upstream could also flip it later. EXECUTION.md claimed
 * "nothing runs unless you commit a file saying it may", and for the
 * documented install that was exactly backwards: this repository shipped
 * `{"enabled": true}` in the clone.
 *
 * So the decision is recorded per machine, keyed by which corpus it applies
 * to, in a file no `git pull` can reach. That is also the shape device
 * management expects: one file an administrator can write and a user cannot
 * silently override by pulling.
 */
export const POLICY_HOME = path.join(os.homedir(), '.cairn', 'policy.json');
export const LEGACY_FILE = 'cairn.policy.json';

const OFF: ExecutionPolicy = { enabled: false, strict: false };

/** `{ "<absolute corpus path>": { "enabled": true } }` */
const StoreSchema = z.record(z.string(), ExecutionPolicySchema);

function readStore(file: string): Record<string, ExecutionPolicy> {
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = StoreSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
    /*
     * A malformed policy is OFF, never on. The failure mode of guessing the
     * other way is executing shell because somebody's JSON had a trailing
     * comma.
     */
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/** The policy file actually consulted, so a refusal can name it. */
export function policyPath(): string {
  return process.env.CAIRN_POLICY || POLICY_HOME;
}

export function executionPolicy(): ExecutionPolicy {
  return readStore(policyPath())[path.resolve(cairnHome())] ?? OFF;
}

/**
 * True when the corpus carries a policy file that no longer does anything.
 *
 * Worth saying out loud rather than ignoring: someone following older
 * instructions, or pulling a repository that still ships one, would otherwise
 * believe execution is enabled and never find out why nothing runs — or
 * worse, believe it is disabled because the file says false.
 */
export function strandedPolicyFile(): string | null {
  const f = homePath(LEGACY_FILE);
  return fs.existsSync(f) ? f : null;
}

export class ExecutionRefused extends Error {
  constructor(what: string) {
    super(
      `refusing to run ${what}: execution is not enabled for this corpus.\n\n` +
        `  Checks are shell commands written by whoever recorded the finding, so\n` +
        `  running them is a decision this machine makes about this corpus — never\n` +
        `  one the corpus can make for it. A policy inside the corpus would travel\n` +
        `  to everyone who cloned it.\n\n` +
        `  To enable, on THIS machine, add the corpus path to ${policyPath()}:\n\n` +
        `    { "${cairnHome()}": { "enabled": true, "note": "who decided, and when" } }\n\n` +
        `  Everything else — search, brief, sync, record — works without it.`,
    );
    this.name = 'ExecutionRefused';
  }
}

/** Throws unless this corpus has opted in to running checks. */
export function assertExecutionAllowed(what: string): void {
  if (!executionPolicy().enabled) throw new ExecutionRefused(what);
}
