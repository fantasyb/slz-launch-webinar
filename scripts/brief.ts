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
import { loadSearchable } from '../src/lib/cairn/federation';
import { brief } from '../src/lib/cairn/brief';
import { retrieve } from '../src/lib/cairn/retrieval';
import { observe } from '../src/lib/cairn/observe';
import { stalenessNote } from '../src/lib/cairn/freshness';

const args = process.argv.slice(2);
const quiet = args.includes('--quiet');
const task = args.filter((a) => !a.startsWith('--')).join(' ');

if (!task.trim()) {
  console.error('usage: npm run cairn:brief -- "<what you are about to do>"');
  process.exit(2);
}

const searchable = loadSearchable();
const corpus = searchable.findings;
const text = brief(task, corpus, { useLocalEnvironment: true, keysFor: searchable.keysFor });
/*
 * Recorded whether or not anything was shown. A brief that stays silent is the
 * common case and is a fact about delivery worth keeping: it is the difference
 * between "we had nothing" and "we had something and withheld it".
 */
observe(task, retrieve(task, corpus, { useLocalEnvironment: true, limit: 5, keysFor: searchable.keysFor }), 'cli:brief');
if (text) {
  process.stdout.write(`${text}\n`);
} else if (!quiet) {
  console.log('\nNothing recorded bears on that. Proceed.\n');
}

/*
 * Said last, so it never buries the answer, and said at all because a corpus
 * that is behind answers in exactly the tone of one that is current.
 */
{
  const note = stalenessNote();
  if (note) console.error(`  (${note})`);
}
