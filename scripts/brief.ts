/**
 * cairn:brief — what does the corpus already know about what you are about to do?
 *
 *   npm run cairn:brief -- "add a page that shows the current server time"
 *   npm run cairn:brief -- --quiet "..."     # print nothing when there is nothing
 *
 * THE THIRD DELIVERY PATH
 *
 * cairn:find answers a question. cairn:find --preflight warns about a command.
 * Both need the reader to do something first -- ask, or run. Measured, that is
 * not a safe assumption: claude-haiku-4-5 given the corpus as a tool never
 * called it once in five trials of a task where the corpus would have changed
 * the answer, and scored exactly as it did with no tool at all.
 *
 * So this one is meant to be called BY the harness rather than by the agent:
 * paste the task, get the findings worth knowing before starting, prepend them
 * to the prompt. It exits 0 with no output when nothing qualifies, which is
 * most tasks, so it is safe to run unconditionally in a hook.
 */
import { loadCorpus } from '../src/lib/cairn/load';
import { brief } from '../src/lib/cairn/brief';

const args = process.argv.slice(2);
const quiet = args.includes('--quiet');
const task = args.filter((a) => !a.startsWith('--')).join(' ');

if (!task.trim()) {
  console.error('usage: npm run cairn:brief -- "<what you are about to do>"');
  process.exit(2);
}

const text = brief(task, loadCorpus(), { useLocalEnvironment: true });
if (text) {
  process.stdout.write(`${text}\n`);
} else if (!quiet) {
  console.log('\nNothing recorded bears on that. Proceed.\n');
}
