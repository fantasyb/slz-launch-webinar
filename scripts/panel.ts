/**
 * Run a forecasting panel: several frontier models, the same sealed claims.
 *
 *   npm run cairn:panel -- seal      # solicit forecasts, seal them, write a manifest
 *   npm run cairn:panel -- reveal    # after the checks have run, reveal them
 *
 * WHY THERE IS A MANIFEST
 *
 * When one operator collects forecasts on behalf of several models, the models
 * are not sealing their own predictions — the operator is. That reintroduces
 * the hole commit-reveal closed, one level up: solicit ten forecasts, run the
 * checks, publish the six that tell a good story, and nobody can tell.
 *
 * So the seal phase writes a manifest naming EVERY (model, finding) pair
 * attempted, including failures, with a batch hash over all of it, and that
 * manifest is committed before any check runs. A dropped forecast then shows
 * up as a hole in a published list rather than as an absence nobody can see.
 * The operator's discretion is removed rather than trusted.
 *
 * Being a neutral party is a property of the protocol, not of the person.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { FindingSchema, type Finding } from '../src/lib/cairn/schema';
import { PanelConfigSchema, solicit, ask, type SolicitResult } from '../src/lib/cairn/panel';
import { computeCommitment, generateNonce } from '../src/lib/cairn/commitment';
import { derivedVerdict } from '../src/lib/cairn/decay';
import { findingBodyHash } from '../src/lib/cairn/signing';
import { writeJsonAtomic } from '../src/lib/cairn/atomic';

const MODE = process.argv[2];
const CORPUS = path.join(process.cwd(), 'cairn');
const RUNS = path.join(process.cwd(), 'panel-runs');
const SECRETS = path.join(process.cwd(), '.cairn-secrets', 'panel');

function loadFindings(): Array<{ file: string; finding: Finding }> {
  return fs
    .readdirSync(CORPUS)
    .filter((f) => f.endsWith('.json'))
    .map((file) => ({
      file,
      finding: FindingSchema.parse(JSON.parse(fs.readFileSync(path.join(CORPUS, file), 'utf8'))),
    }));
}

function loadConfig() {
  const raw = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'panel.config.json'), 'utf8'));
  delete raw._comment;
  return PanelConfigSchema.parse(raw);
}

async function seal() {
  const cfg = loadConfig();
  const anchor = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  const runId = `panel-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}`;

  // Only findings that are unresolved for a given member, and automatable, so
  // the check can actually settle the forecast.
  const candidates = loadFindings().filter(
    ({ finding }) => finding.status === 'active' && !finding.check.manual,
  );
  console.log(`${runId}: ${cfg.members.length} members x ${candidates.length} findings\n`);

  const attempts: Array<{
    member: string;
    provider: string;
    model: string;
    findingId: string;
    status: 'sealed' | 'error';
    commitment?: string;
    error?: string;
  }> = [];

  // Two labels that sanitise to the same filename would have one preimage
  // overwrite the other, and the loser's sealed forecast becomes permanently
  // unrevealable. Cheap to check, impossible to recover from.
  const filenames = new Map<string, string>();
  for (const m of cfg.members) {
    const key = secretName(m.label);
    const clash = filenames.get(key);
    if (clash) {
      console.error(`members "${clash}" and "${m.label}" both map to the secret file ${key}`);
      console.error('One would overwrite the other and its forecast could never be revealed.');
      process.exit(2);
    }
    filenames.set(key, m.label);
  }

  fs.mkdirSync(SECRETS, { recursive: true, mode: 0o700 });
  fs.mkdirSync(RUNS, { recursive: true });

  // The manifest exists so an operator cannot solicit forecasts and quietly
  // drop the unflattering ones. Writing it after the loop meant Ctrl-C partway
  // through — or after watching the solicitations scroll past — left sealed
  // commitments in the corpus with no record of what else was attempted, which
  // is precisely the discretion the manifest is meant to remove. It is now
  // rewritten before every corpus mutation, so it always covers at least what
  // has been published.
  const flushManifest = (): string => {
    const batchHash = crypto
      .createHash('sha256')
      .update(
        JSON.stringify(
          [...attempts].sort((a, b) =>
            `${a.findingId}${a.member}`.localeCompare(`${b.findingId}${b.member}`),
          ),
        ),
      )
      .digest('hex');
    writeJsonAtomic(path.join(RUNS, `${runId}.json`), {
      runId,
      createdAt: new Date().toISOString(),
      anchor,
      members: cfg.members,
      attempts,
      batchHash,
      note:
        'Every (model, finding) pair attempted in this run, including failures. ' +
        'Written before the corpus seals it describes, so an interrupted run ' +
        'leaves a manifest listing forecasts the corpus may not yet carry — ' +
        'never the reverse.',
    });
    return batchHash;
  };

  for (const { file, finding } of candidates) {
    const raw = JSON.parse(fs.readFileSync(path.join(CORPUS, file), 'utf8'));

    const results: SolicitResult[] = await Promise.all(
      cfg.members
        .filter((m) => !finding.predictions.some((p) => p.by === m.label))
        .map((m) => solicit(m, finding, cfg)),
    );

    for (const r of results) {
      if (!r.forecast) {
        // Recorded, not hidden. A hole must be visible.
        attempts.push({
          member: r.member.label,
          provider: r.member.provider,
          model: r.member.model,
          findingId: finding.id,
          status: 'error',
          error: r.error,
        });
        console.log(`  ERR  ${finding.id} ${r.member.label}: ${r.error?.slice(0, 90)}`);
        continue;
      }

      const nonce = generateNonce();
      const hash = computeCommitment({
        findingId: finding.id,
        by: r.member.label,
        priorConfirmed: r.forecast.priorConfirmed,
        reasoning: r.forecast.reasoning,
        anchor,
        nonce,
      });

      raw.predictions.push({
        at: new Date().toISOString(),
        by: r.member.label,
        commitment: { algorithm: 'sha256', hash, anchor },
        bodyHash: findingBodyHash(finding),
        self: false,
      });

      // 0600: until reveal, these preimages are the whole blind.
      writeJsonAtomic(
        path.join(SECRETS, `${finding.id}--${secretName(r.member.label)}.json`),
        { findingId: finding.id, by: r.member.label, ...r.forecast, anchor, nonce, hash },
        0o600,
      );

      attempts.push({
        member: r.member.label,
        provider: r.member.provider,
        model: r.member.model,
        findingId: finding.id,
        status: 'sealed',
        commitment: hash,
      });
      console.log(`  seal ${finding.id} ${r.member.label}  ${hash.slice(0, 12)}`);
    }

    flushManifest();
    writeJsonAtomic(path.join(CORPUS, file), raw);
  }

  const batchHash = flushManifest();

  const sealed = attempts.filter((a) => a.status === 'sealed').length;
  console.log(`\n${sealed} sealed, ${attempts.length - sealed} errored`);
  console.log(`manifest  panel-runs/${runId}.json   batch ${batchHash.slice(0, 16)}`);
  console.log('\nCOMMIT AND PUSH NOW, before running any check:\n');
  console.log(`  git add cairn/ panel-runs/ && git commit -m "seal: ${runId}" && git push\n`);
  console.log('Then run the checks, then: npm run cairn:panel -- reveal');
}

function reveal() {
  if (!fs.existsSync(SECRETS)) {
    console.error('no sealed panel forecasts found');
    process.exit(2);
  }
  let revealed = 0;
  let broken = 0;

  for (const { file, finding } of loadFindings()) {
    const raw = JSON.parse(fs.readFileSync(path.join(CORPUS, file), 'utf8'));
    let touched = false;

    for (const secretFile of fs.readdirSync(SECRETS)) {
      if (!secretFile.startsWith(`${finding.id}--`)) continue;
      const s = JSON.parse(fs.readFileSync(path.join(SECRETS, secretFile), 'utf8'));

      const idx = raw.predictions.findIndex(
        (p: { by: string; commitment?: { hash: string }; outcome?: string }) =>
          p.by === s.by && p.commitment?.hash === s.hash && !p.outcome,
      );
      if (idx === -1) continue;

      // Recompute the commitment from the preimage rather than comparing the
      // stored hash against a copy of itself. Trusting `s.hash` meant an edited
      // secret file — reasoning rewritten, hash field left alone — was published
      // as the revealed forecast while this script exited 0 reporting success.
      const recomputed = computeCommitment({
        findingId: s.findingId,
        by: s.by,
        priorConfirmed: s.priorConfirmed,
        reasoning: s.reasoning,
        anchor: s.anchor,
        nonce: s.nonce,
      });
      if (recomputed !== raw.predictions[idx].commitment?.hash) {
        console.error(`  SEAL BROKEN ${finding.id} ${s.by} — preimage does not reproduce the`);
        console.error('    published hash. Refusing to reveal this forecast.');
        broken += 1;
        continue;
      }

      // Derived from the whole observation set, not the newest entry (one
      // appended line must not retroactively redefine every panellist's
      // ground truth at once), and only from evidence postdating that
      // panellist's own seal, so a forecast cannot be resolved by
      // observations that already existed when it was made.
      const outcome = derivedVerdict(finding, {
        since: new Date(raw.predictions[idx].at),
      });
      if (outcome === 'inconclusive') {
        console.log(`  skip ${finding.id} ${s.by} — no observation recorded since the seal`);
        continue;
      }

      raw.predictions[idx] = {
        ...raw.predictions[idx],
        revealedAt: new Date().toISOString(),
        nonce: s.nonce,
        priorConfirmed: s.priorConfirmed,
        reasoning: s.reasoning,
        outcome,
        resolvedAt: new Date().toISOString(),
      };
      touched = true;
      revealed++;
      const err = Math.abs(s.priorConfirmed - (outcome === 'confirmed' ? 1 : 0));
      console.log(
        `  ${finding.id} ${s.by.padEnd(16)} ${s.priorConfirmed.toFixed(2)} -> ${outcome}  brier ${(err * err).toFixed(3)}`,
      );
    }

    if (touched) writeJsonAtomic(path.join(CORPUS, file), raw);
  }

  console.log(`\n${revealed} forecast(s) revealed. Commit, then: npm run cairn:audit`);
  if (broken > 0) {
    console.error(`${broken} forecast(s) had a broken seal and were not revealed.`);
    process.exit(1);
  }
}

/** Filename form of a member label. Collisions are rejected before sealing. */
function secretName(label: string): string {
  return label.replace(/[^\w.-]/g, '_');
}

/**
 * Preflight: call every configured member with a trivial prompt and report
 * what actually happens.
 *
 * The panel had never run, so nothing had ever confirmed that the model ids in
 * panel.config.json resolve, that each provider's request shape is right, or
 * that a reply parses. A stale id is not a loud failure -- it is one panellist
 * quietly missing from every run. This answers those questions for the price
 * of four short requests, and it is the thing to run before a real seal.
 */
async function check() {
  const cfg = loadConfig();
  console.log(`checking ${cfg.members.length} member(s), maxTokens ${cfg.maxTokens}\n`);
  let bad = 0;
  let probed = 0;

  for (const m of cfg.members) {
    const key = process.env[m.apiKeyEnv];
    if (!key) {
      console.log(`skip  ${m.label.padEnd(16)} ${m.apiKeyEnv} is not set`);
      continue;
    }
    probed++;
    const started = Date.now();
    const res = await ask(
      m,
      'You are a test probe. Answer with valid JSON only.',
      'Reply with exactly: {"ok": true}',
      cfg,
    );
    const ms = Date.now() - started;
    if (res.error) {
      console.log(`FAIL  ${m.label.padEnd(16)} ${m.model}  ${res.error.slice(0, 120)}`);
      bad++;
      continue;
    }
    const text = (res.text ?? '').trim();
    if (!text) {
      // The specific failure a small maxTokens produces: the budget is spent on
      // reasoning and nothing visible is emitted.
      console.log(
        `FAIL  ${m.label.padEnd(16)} ${m.model}  empty response in ${ms}ms — ` +
          `raise maxTokens or lower effort`,
      );
      bad++;
      continue;
    }
    console.log(`ok    ${m.label.padEnd(16)} ${m.model}  ${ms}ms  ${text.slice(0, 60)}`);
  }

  // Report what was examined, not just the verdict. A preflight that probed
  // nothing and printed "all members answered" is cairn-0028 exactly: a gate
  // whose selector returned nothing, passing vacuously. It was written that
  // way here first time round.
  console.log(`\n${probed} of ${cfg.members.length} member(s) probed, ${bad} failed`);
  if (probed === 0) {
    console.error('No member had a key set, so nothing was checked. Set at least one');
    console.error('provider key before treating this as a pass.');
    process.exit(2);
  }
  process.exit(bad === 0 ? 0 : 1);
}

if (MODE === 'check') {
  check().catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else if (MODE === 'seal') {
  seal().catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else if (MODE === 'reveal') {
  reveal();
} else {
  console.error('usage: npm run cairn:panel -- <check|seal|reveal>');
  process.exit(2);
}
