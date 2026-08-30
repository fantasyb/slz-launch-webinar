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
import { PanelConfigSchema, solicit, type SolicitResult } from '../src/lib/cairn/panel';
import { computeCommitment, generateNonce } from '../src/lib/cairn/commitment';

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

  fs.mkdirSync(SECRETS, { recursive: true });

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
        self: false,
      });

      fs.writeFileSync(
        path.join(SECRETS, `${finding.id}--${r.member.label.replace(/[^\w.-]/g, '_')}.json`),
        `${JSON.stringify({ findingId: finding.id, by: r.member.label, ...r.forecast, anchor, nonce, hash }, null, 2)}\n`,
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

    fs.writeFileSync(path.join(CORPUS, file), `${JSON.stringify(raw, null, 2)}\n`);
  }

  // Batch hash over every attempt, sorted, so the manifest cannot be pruned.
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

  fs.mkdirSync(RUNS, { recursive: true });
  fs.writeFileSync(
    path.join(RUNS, `${runId}.json`),
    `${JSON.stringify(
      {
        runId,
        createdAt: new Date().toISOString(),
        anchor,
        members: cfg.members,
        attempts,
        batchHash,
        note:
          'Every (model, finding) pair attempted in this run, including failures. ' +
          'Published before any check was executed, so a forecast missing from the ' +
          'ledger is visible as a hole here rather than as an absence nobody can see.',
      },
      null,
      2,
    )}\n`,
  );

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

      // The outcome comes from the finding's own latest observation: the check
      // has already been run and judged by a human or by cairn:verify.
      const latest = [...finding.observations].sort(
        (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
      )[0];
      if (!latest || latest.verdict === 'inconclusive') {
        console.log(`  skip ${finding.id} ${s.by} — no decisive observation yet`);
        continue;
      }

      raw.predictions[idx] = {
        ...raw.predictions[idx],
        revealedAt: new Date().toISOString(),
        nonce: s.nonce,
        priorConfirmed: s.priorConfirmed,
        reasoning: s.reasoning,
        outcome: latest.verdict,
        resolvedAt: new Date().toISOString(),
      };
      touched = true;
      revealed++;
      const err = Math.abs(s.priorConfirmed - (latest.verdict === 'confirmed' ? 1 : 0));
      console.log(
        `  ${finding.id} ${s.by.padEnd(16)} ${s.priorConfirmed.toFixed(2)} -> ${latest.verdict}  brier ${(err * err).toFixed(3)}`,
      );
    }

    if (touched) fs.writeFileSync(path.join(CORPUS, file), `${JSON.stringify(raw, null, 2)}\n`);
  }

  console.log(`\n${revealed} forecast(s) revealed. Commit, then: npm run cairn:audit`);
}

if (MODE === 'seal') {
  seal().catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else if (MODE === 'reveal') {
  reveal();
} else {
  console.error('usage: npm run cairn:panel -- <seal|reveal>');
  process.exit(2);
}
