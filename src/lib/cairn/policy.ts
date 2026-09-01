import fs from 'fs';
import { z } from 'zod';
import { homePath } from './home';

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

export const POLICY_FILE = 'cairn.policy.json';

const OFF: ExecutionPolicy = { enabled: false, strict: false };

export function executionPolicy(): ExecutionPolicy {
  const file = homePath(POLICY_FILE);
  if (!fs.existsSync(file)) return OFF;
  try {
    const parsed = ExecutionPolicySchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
    /*
     * A malformed policy is OFF, never on. The failure mode of guessing the
     * other way is executing shell because somebody's JSON had a trailing
     * comma.
     */
    return parsed.success ? parsed.data : OFF;
  } catch {
    return OFF;
  }
}

export class ExecutionRefused extends Error {
  constructor(what: string) {
    super(
      `refusing to run ${what}: execution is not enabled for this corpus.\n\n` +
        `  Checks are shell commands written by whoever recorded the finding. Running\n` +
        `  them is opt-in per corpus, not per command, so the decision is reviewable.\n\n` +
        `  To enable, commit ${POLICY_FILE} at the root of the corpus:\n\n` +
        `    { "enabled": true, "note": "who decided this, and when" }\n\n` +
        `  Everything else — search, brief, sync, record — works without it.`,
    );
    this.name = 'ExecutionRefused';
  }
}

/** Throws unless this corpus has opted in to running checks. */
export function assertExecutionAllowed(what: string): void {
  if (!executionPolicy().enabled) throw new ExecutionRefused(what);
}
