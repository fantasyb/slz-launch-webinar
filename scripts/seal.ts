/**
 * cairn:seal — sign this machine's own findings and commit them, with nobody
 * doing it by hand. Run automatically at the end of a triage pass; safe to run
 * by hand too. No-ops cleanly when there is no identity, nothing unsigned, or no
 * git repo. It signs only observations authored under this machine's key label,
 * and it commits locally — it never pushes (see autoseal.ts).
 *
 *   npm run cairn:seal
 */
import { sealAndCommit } from '../src/lib/cairn/autoseal';

const message = process.argv.slice(2).join(' ').trim() || undefined;
const r = sealAndCommit(message);

if (!r.identity) {
  console.log('cairn:seal — no signing identity on this machine; nothing signed.');
} else {
  console.log(`cairn:seal — as "${r.identity}": signed ${r.signed} observation(s)${r.committed ? ', committed' : ''}.`);
}
