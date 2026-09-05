/**
 * Freshness that is real, and visible when it is not.
 *
 * "Trust decay is existential, everything else is polish." A finding's
 * standing decays on a timer, and a timer knows nothing: it cannot tell a
 * trap that still bites from one the platform fixed last week, and it
 * cannot tell either from a check nobody can run. Forty-six percent of the
 * findings in the first real corpus carry a manual check, which no schedule
 * will ever re-run. For those, the only observer there is, is the agent that
 * just reached for the tool -- it has just seen whether the trap held.
 *
 * So two things live here. `attest` appends an observation to a finding in
 * the local corpus: the deliberate act the format was built around, made
 * reachable from the gateway as `cairn_observe`. Unsigned, like a finding
 * recorded through cairn_record; the scoring already weights an unsigned
 * refutation so that one line cannot veto a signed corpus. `verification`
 * says, for any finding, what its standing rests on -- confirmed by a
 * machine check, attested by a person or agent, or never confirmed at all --
 * and whether the check could be run by a machine, so that "verified
 * yesterday by a check" and "asserted once and never re-run" never read the
 * same.
 */
import fs from 'fs';
import os from 'os';
import { z } from 'zod';
import { FindingSchema, type Finding } from './schema';
import { resolveFindingFile } from './resolve';
import { writeJsonAtomic } from './atomic';
import { homePath } from './home';
import { standing, lastConfirmedAt, daysSince, type Standing } from './decay';
import { scanInjection, scanSensitive, draftSurface } from './safety';
import { signObservation, findingBodyHash, CURRENT_HASH_VERSION } from './signing';
import { reloadKeys } from './keys';

export const VERDICTS = ['confirmed', 'refuted', 'inconclusive'] as const;
export type Verdict = (typeof VERDICTS)[number];

/** Past this, a finding served by the gateway asks to be re-confirmed by whoever just used the tool. */
export const REVERIFY_AFTER_DAYS = 14;

/** The one identity a machine check writes under; everything else is a person or an agent attesting. */
export const MACHINE_OBSERVER = 'doctor';

export const AttestationSchema = z.object({
  finding: z.string().regex(/^cairn-\d{4}$/, 'a finding id, cairn-NNNN'),
  verdict: z.enum(VERDICTS),
  /** Required unless confirming: a refutation or a shrug with no reason is noise. */
  note: z.string().max(4000).optional(),
  by: z.string().min(1).max(200),
});

export interface AttestOutcome {
  ok: boolean;
  message: string;
  finding?: Finding;
  file?: string;
  standing?: Standing;
}

/**
 * Signed when the operator gave the gateway a key (CAIRN_KEY, its private
 * half in the corpus home's .cairn-secrets/), under that key's label. The
 * difference is not cosmetic: the scoring lets no unsigned line veto a
 * signed corpus, so an unsigned refutation is shown on the finding and does
 * not move its standing, while a signed one stands as contested until
 * distinct confirmers outnumber it two to one. A key is the operator saying
 * "this gateway's observations are mine".
 */
export function attest(raw: unknown, opts: { by?: string; via?: string; keyId?: string } = {}): AttestOutcome {
  const withBy = typeof raw === 'object' && raw !== null && opts.by && !(raw as Record<string, unknown>).by
    ? { ...(raw as Record<string, unknown>), by: opts.by }
    : raw;
  const parsed = AttestationSchema.safeParse(withBy);
  if (!parsed.success) {
    return { ok: false, message: `Not recorded:\n${parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')}` };
  }
  const a = parsed.data;
  if (a.verdict !== 'confirmed' && (a.note ?? '').trim().length < 10) {
    return { ok: false, message: `Not recorded: a "${a.verdict}" needs a note saying what was seen (at least 10 characters). What did the call return?` };
  }
  const flags = [...scanInjection(draftSurface(a)), ...scanSensitive(draftSurface(a))];
  if (flags.length) {
    return { ok: false, message: `Refused — the note must not be committed:\n${flags.map((f) => `  ${f.pattern}: ${f.reason}`).join('\n')}` };
  }
  let file: string;
  try {
    file = resolveFindingFile(a.finding, homePath('cairn'));
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const rawFinding = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  const key = opts.keyId ? reloadKeys().get(opts.keyId) : undefined;
  const privFile = opts.keyId ? homePath('.cairn-secrets', `${opts.keyId}.key`) : null;
  const signable = !!(key && privFile && fs.existsSync(privFile));
  /*
   * A caller-supplied (model) `by` must not claim a reserved identity — the
   * machine-observer label (which makes verification read as "verified by its
   * check") or a local signing key's label — unless it is actually being signed
   * by that key here. Only a `by` the model itself set (raw.by) is untrusted;
   * a code-set opts.by (doctor's own path) is fine.
   */
  const modelBy = typeof raw === 'object' && raw !== null && typeof (raw as Record<string, unknown>).by === 'string'
    ? String((raw as Record<string, unknown>).by)
    : undefined;
  if (modelBy) {
    const reserved = modelBy === MACHINE_OBSERVER || [...reloadKeys().values()].some((k) => k.label === modelBy);
    if (reserved && !(signable && key!.label === modelBy)) {
      return { ok: false, message: `"${modelBy}" is a reserved signing identity on this machine; an unsigned observation cannot claim it. Use your own agent id.` };
    }
  }
  const observation = {
    at: new Date().toISOString(),
    by: signable ? key!.label : a.by,
    verdict: a.verdict,
    ...(a.note?.trim() ? { note: a.note.trim() } : {}),
    environment: { os: process.platform, arch: process.arch, runtime: `node ${process.version}`, note: `${os.type()} ${os.release()}${opts.via ? `; via ${opts.via}` : ''}` },
  };
  let signed: Record<string, unknown> = observation;
  if (signable) {
    const body = FindingSchema.safeParse(rawFinding);
    if (body.success) {
      const value = signObservation(a.finding, observation, fs.readFileSync(privFile!, 'utf8'), findingBodyHash(body.data, CURRENT_HASH_VERSION));
      signed = { ...observation, hashVersion: CURRENT_HASH_VERSION, signature: { algorithm: 'ed25519', keyId: opts.keyId, value } };
    }
  }
  rawFinding.observations = [...((rawFinding.observations as unknown[]) ?? []), signed];
  const checked = FindingSchema.safeParse(rawFinding);
  if (!checked.success) {
    return { ok: false, message: `The finding did not validate with the observation added:\n${checked.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}` };
  }
  writeJsonAtomic(file, rawFinding);
  const s = standing(checked.data);
  return {
    ok: true,
    finding: checked.data,
    file,
    standing: s,
    message:
      `Recorded ${a.verdict} on ${a.finding} by ${observation.by}; it now stands ${s}.` +
      (signable
        ? ` Signed by ${opts.keyId}.` + (a.verdict === 'refuted' ? ' A refutation stands until confirmations from distinct signers outnumber refuters two to one.' : '')
        : a.verdict === 'refuted'
          ? ' Unsigned, so it is shown on the finding but does not move its standing; give the gateway a key (CAIRN_KEY) for refutations to count.'
          : ' Unsigned, so it counts as one environment.'),
  };
}

export interface Verification {
  standing: Standing;
  lastConfirmedAt: string | null;
  daysSinceConfirmed: number | null;
  confirmedBy: string | null;
  /** What the latest confirmation was: a machine check, a person or agent, or nothing. */
  source: 'machine' | 'attested' | 'none';
  /** Whether a machine could re-run the check at all. */
  checkable: boolean;
  refuted: number;
  inconclusive: number;
  /** Older than REVERIFY_AFTER_DAYS, or never confirmed. */
  due: boolean;
}

export function verification(f: Finding, now = new Date()): Verification {
  const at = lastConfirmedAt(f, now);
  const latest = at ? f.observations.filter((o) => o.verdict === 'confirmed' && o.at === at)[0] : undefined;
  const days = at ? daysSince(at, now) : null;
  return {
    standing: standing(f, now),
    lastConfirmedAt: at,
    daysSinceConfirmed: days,
    confirmedBy: latest?.by ?? null,
    source: !latest ? 'none' : latest.by === MACHINE_OBSERVER ? 'machine' : 'attested',
    checkable: !f.check.manual,
    refuted: f.observations.filter((o) => o.verdict === 'refuted').length,
    inconclusive: f.observations.filter((o) => o.verdict === 'inconclusive').length,
    due: days === null || days >= REVERIFY_AFTER_DAYS,
  };
}

const ago = (days: number) => (days < 1 ? 'today' : days < 2 ? '1 day ago' : `${Math.floor(days)} days ago`);

/** One line a reader can weigh: what the standing rests on. */
export function verificationLine(f: Finding, now = new Date()): string {
  const v = verification(f, now);
  const how =
    v.source === 'none'
      ? 'never confirmed'
      : v.source === 'machine'
        ? `verified by its check ${ago(v.daysSinceConfirmed!)}`
        : `attested by ${v.confirmedBy} ${ago(v.daysSinceConfirmed!)}, not by a check`;
  const check = v.checkable ? 'check runnable' : 'check is manual: no machine can re-run it';
  const contested = v.refuted ? `; ${v.refuted} refutation${v.refuted > 1 ? 's' : ''} on record` : '';
  return `${v.standing} — ${how}; ${check}${contested}`;
}
