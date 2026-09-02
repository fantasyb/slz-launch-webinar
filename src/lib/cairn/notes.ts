/**
 * The second tier: a note is what you write when the deploy is failing in
 * front of you and the finding can wait.
 *
 * A finding costs thinking -- claim, expectation, reality, a check that can
 * refute itself -- and the thinking is the value; loosen it and the corpus
 * is a wiki. But the thinking is paid mid-work, by someone with a failure in
 * front of them, and "I'll write it later" means never. What the session
 * already has, without thinking, is the title, the tool, the exact command
 * and its output, and the fix that worked. A note is exactly those, and
 * nothing else. One call.
 *
 * WHERE IT LIVES IS THE WHOLE SAFETY ARGUMENT. A note is written to drafts/,
 * never to cairn/. cairn_find searches cairn/. The gateway indexes cairn/.
 * federationBundle() reads cairn/. A note therefore cannot be cited, scored,
 * federated or served: it is a stub by construction, not by a flag that
 * something could forget to check. The bar for cairn/ does not move --
 * cairn_record demands today what it demanded yesterday -- and nothing here
 * derives a claim from a title, because a claim generated from a title is
 * the thin, true, mechanism-free entry cairn-0034 measured as retrieved and
 * worthless. The tier defers the thinking; it does not fake it.
 *
 * THE CLOSE. A note is offered back once, on the first result from its tool
 * in a later session -- the moment the person is back in the same territory
 * and the memory is fresh again -- with the evidence already in it. Finish it
 * with cairn_record, or discard it. After ABANDON_AFTER_DAYS it is listed as
 * abandoned and never offered again; it stays on disk with its timestamp,
 * which is honest data about what was noticed and never finished.
 *
 * The scan is the finding's scan. A note from a production session carries
 * the same risk as a finding from one, and the secret gate is not tiered.
 */
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { homePath } from './home';
import { scanExecutable, scanInjection, scanSensitive, draftSurface, redact } from './safety';
import { slugify, likelyDuplicates } from './submission';

export const ABANDON_AFTER_DAYS = 14;

export const NoteSchema = z.object({
  title: z.string().min(1).max(120),
  /** The MCP tool this is about, named exactly. What brings it back. */
  tool: z.string().min(2).max(120),
  evidence: z
    .array(z.object({ command: z.string().min(1).max(4000), output: z.string().max(20000), note: z.string().max(2000).optional() }))
    .min(1, 'include at least one: the command you ran and what it printed')
    .max(20),
  workaround: z.string().max(4000).optional(),
  by: z.string().min(1).max(200),
});
export type NoteInput = z.infer<typeof NoteSchema>;

export interface Note extends NoteInput {
  kind: 'note';
  id: string;
  at: string;
  /** The gateway session that wrote it, so that session is not offered its own note back. */
  session?: string;
  status: 'open' | 'finished' | 'discarded';
  /** Set when finished: the finding it became. */
  findingId?: string;
  closedAt?: string;
}

export interface NoteOutcome {
  ok: boolean;
  message: string;
  note?: Note;
  file?: string;
}

const dir = () => homePath('drafts');

function ensureDir(): string {
  const d = dir();
  fs.mkdirSync(d, { recursive: true });
  const ignore = path.join(d, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
  return d;
}

export function recordNote(raw: unknown, opts: { by?: string; session?: string } = {}): NoteOutcome {
  const withBy = typeof raw === 'object' && raw !== null && opts.by && !(raw as Record<string, unknown>).by
    ? { ...(raw as Record<string, unknown>), by: opts.by }
    : raw;
  const parsed = NoteSchema.safeParse(withBy);
  if (!parsed.success) {
    return { ok: false, message: `Not noted:\n${parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')}` };
  }
  const data = parsed.data;
  const surface = draftSurface(data as unknown as Record<string, unknown>);
  const flags = [...scanExecutable(surface), ...scanInjection(surface), ...scanSensitive(surface)];
  if (flags.length) {
    return {
      ok: false,
      message:
        `Refused — this must not be kept:\n${flags
          .map((f) => {
            const fixed = redact(f.sample).text;
            return `  ${f.pattern}: ${f.reason} — ${JSON.stringify(f.sample)}${fixed !== f.sample ? `\n    accepted if written as ${JSON.stringify(fixed)}` : ''}`;
          })
          .join('\n')}\nNothing was written.`,
    };
  }
  const at = new Date();
  const id = `note-${at.getTime().toString(36)}`;
  const note: Note = { kind: 'note', id, at: at.toISOString(), session: opts.session, status: 'open', ...data };
  const d = ensureDir();
  const file = path.join(d, `${id}-${slugify(data.title)}.json`);
  fs.writeFileSync(file, `${JSON.stringify(note, null, 2)}\n`);
  return {
    ok: true,
    note,
    file,
    message: `Noted (${id}); not a finding until claim, expectation, reality and check are filled — cairn_record, with this evidence, when you know them.`,
  };
}

function readAll(): Array<{ note: Note; file: string }> {
  const d = dir();
  if (!fs.existsSync(d)) return [];
  const out: Array<{ note: Note; file: string }> = [];
  for (const f of fs.readdirSync(d).filter((x) => x.startsWith('note-') && x.endsWith('.json'))) {
    try {
      const note = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')) as Note;
      if (note.kind === 'note' && note.id) out.push({ note, file: path.join(d, f) });
    } catch { /* one bad file never hides the rest */ }
  }
  return out.sort((a, b) => a.note.at.localeCompare(b.note.at));
}

export const ageDays = (note: Note, now = new Date()) => (now.getTime() - Date.parse(note.at)) / 86_400_000;
export const isAbandoned = (note: Note, now = new Date()) => note.status === 'open' && ageDays(note, now) > ABANDON_AFTER_DAYS;

/** Every note, with what it is now: open, abandoned (open and too old to offer), finished, discarded. */
export function listNotes(now = new Date()): Array<{ note: Note; file: string; state: 'open' | 'abandoned' | 'finished' | 'discarded' }> {
  return readAll().map((n) => ({ ...n, state: n.note.status === 'open' ? (isAbandoned(n.note, now) ? 'abandoned' : 'open') : n.note.status }));
}

/** Open notes about a tool, by any of the names the tool goes by, that a later session may be offered. */
export function openNotesFor(toolNames: string[], now = new Date()): Note[] {
  const names = new Set(toolNames.map((n) => n.toLowerCase()));
  return listNotes(now)
    .filter((n) => n.state === 'open' && names.has(n.note.tool.toLowerCase()))
    .map((n) => n.note);
}

function update(id: string, patch: Partial<Note>): Note | null {
  const hit = readAll().find((n) => n.note.id === id);
  if (!hit) return null;
  const note = { ...hit.note, ...patch };
  fs.writeFileSync(hit.file, `${JSON.stringify(note, null, 2)}\n`);
  return note;
}

export function discardNote(id: string): Note | null {
  return update(id, { status: 'discarded', closedAt: new Date().toISOString() });
}

/**
 * A finding landed: close the note it came from. By id when the writer said
 * which; otherwise any open note about the same tool whose title reads as the
 * same trap, so a note finished without naming itself does not linger as a
 * stub beside the finding it became.
 */
export function finishNotes(finding: { id: string; title: string; triggers?: string[] }, noteId?: string): Note[] {
  const closed: Note[] = [];
  const now = new Date().toISOString();
  for (const { note } of readAll()) {
    if (note.status !== 'open') continue;
    const named = noteId !== undefined && note.id === noteId;
    const sameTool = (finding.triggers ?? []).some((t) => t.trim().toLowerCase().split(/\s+/)[0] === note.tool.toLowerCase());
    /* likelyDuplicates reads tags and subject; a caller may hand in less than a full finding. */
    const shaped = { ...finding, tags: (finding as { tags?: string[] }).tags ?? [], subject: (finding as { subject?: { name: string } }).subject ?? { name: '' } };
    const sameTrap = sameTool && likelyDuplicates(note.title, [shaped as never]).length > 0;
    if (named || sameTrap) {
      const n = update(note.id, { status: 'finished', findingId: finding.id, closedAt: now });
      if (n) closed.push(n);
    }
  }
  return closed;
}
