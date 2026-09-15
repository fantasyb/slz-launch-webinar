/** Guided onboarding for existing MCP connections. No upstream smoke calls:
 * discovery is read-only; real client traffic establishes coverage. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { CLIENTS, LABELS, anonymousCoverage, connect, coverage, discover, publicDiscovery, readManifest, stateRoot, undo, type ClientKind } from '../src/lib/cairn/setup';
import { installRoot, setCairnHome } from '../src/lib/cairn/home';
import { readLedger, type RetrievalRecord } from '../src/lib/cairn/ledger';

async function main() {
  const args = process.argv.slice(2), has = (s: string) => args.includes(s);
  const values = new Set(['--project', '--config', '--home', '--state-dir', '--only']);
  const flags = new Set(['--help', '--discover', '--check', '--json', '--share', '--yes', '--all-supported', '--autowrite', '--undo']);
  const opts = new Map<string, string[]>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (values.has(a)) { const v = args[++i]; if (!v || v.startsWith('--')) throw new Error(`${a} needs a value.`); opts.set(a, [...(opts.get(a) ?? []), v]); }
    else if (!flags.has(a)) throw new Error(`Unknown option. Run npm run cairn:setup -- --help.`);
  }
  if (has('--help')) {
    console.log('Cairn guided setup\n\n  npm run cairn:setup                  Discover, choose connections, connect\n  npm run cairn:setup -- --check       Verify recent traffic and find coverage gaps\n  npm run cairn:setup -- --discover    Read-only discovery\n  npm run cairn:setup -- --share       Anonymous coverage report; uploads nothing\n  npm run cairn:setup -- --undo        Restore managed connections; preserve later edits\n\nOptions: --project /path (repeatable); --config client=/path (repeatable)\nClients: claude, desktop, cursor, windsurf, vscode, codex\nNoninteractive install: --yes --all-supported [--autowrite], or --yes --only ID (repeatable)\nCustom storage: --home /private/corpus --state-dir /private/setup\n--json is local diagnostic output and includes names/paths. --share omits them.');
    return;
  }
  const one = (k: string, fallback: string) => { const vs = opts.get(k); if (vs && vs.length !== 1) throw new Error(`${k} must appear once.`); return vs?.[0] ?? fallback; };
  const dir = path.resolve(one('--state-dir', stateRoot())), root = installRoot() ?? process.cwd();
  const manifest = readManifest(dir);
  const homes = [...new Set(manifest.connections.map((c) => c.home))];
  const home = path.resolve(one('--home', homes[0] ?? path.join(os.homedir(), '.cairn/corpus')));
  const projects = (opts.get('--project') ?? []).map((p) => path.resolve(p));
  for (const p of projects) if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw new Error('A selected project folder does not exist. Choose an existing folder.');
  const extra = (opts.get('--config') ?? []).map((v) => {
    const i = v.indexOf('='), client = v.slice(0, i) as ClientKind;
    if (i < 1 || !CLIENTS.includes(client) || !v.slice(i + 1)) throw new Error('--config needs client=/absolute/path. See --help for client names.');
    return { client, file: path.resolve(v.slice(i + 1)) };
  });
  const readOnly = has('--discover') || has('--check') || has('--json') || has('--share');
  if (has('--undo') && readOnly) throw new Error('Use --undo separately from discovery and reporting.');
  if (has('--autowrite') && readOnly) throw new Error('Capture is enabled during setup, not during a report.');
  if (has('--undo')) {
    const result = undo(dir);
    console.log(`Restored ${result.restored} connections. Restart the affected apps.`);
    if (result.conflicts.length) { console.log(`${result.conflicts.length} connections changed after setup and were left untouched. Run --check to locate them; backups and recovery records remain private.`); process.exitCode = 2; }
    return;
  }
  if (has('--yes') && !has('--all-supported') && !opts.has('--only')) throw new Error('Choose --all-supported or --only ID with --yes.');
  const rl = !readOnly && !has('--yes') && stdin.isTTY && stdout.isTTY ? createInterface({ input: stdin, output: stdout }) : null;
  try {
    if (rl) {
      console.log('Cairn setup\nFind your existing tool connections, connect the supported ones, then verify them in your normal apps.');
      console.log('Standard app locations and Claude-known projects are discovered automatically.');
      while (true) {
        const p = (await rl.question('Add a project folder you work in (paste its full path, or Enter to continue): ')).trim().replace(/^"(.*)"$/, '$1');
        if (!p) break;
        const expanded = p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : path.resolve(p);
        if (!fs.existsSync(expanded) || !fs.statSync(expanded).isDirectory()) { console.log('That folder was not found. Try again.'); continue; }
        projects.push(expanded);
      }
    }
    const found = discover({ projects, extra, manifest });
    const rows: RetrievalRecord[] = [];
    let unreadableHomes = 0;
    for (const h of homes) {
      try { if (fs.existsSync(path.join(h, 'cairn'))) { setCairnHome(h); rows.push(...readLedger()); } else unreadableHomes++; }
      catch { unreadableHomes++; }
    }
    const report = coverage(found, manifest, rows);
    if (has('--share')) { console.log(JSON.stringify({ ...anonymousCoverage(report), unreadableCorpora: unreadableHomes }, null, 2)); return; }
    if (has('--json')) { console.log(JSON.stringify(has('--discover') ? publicDiscovery(found) : { ...report, unreadableCorpora: unreadableHomes }, null, 2)); return; }
    console.log(`\nFound ${found.connections.length} tool connections in ${new Set(found.files.map((f) => f.file)).size} configuration files.`);
    found.connections.forEach((c, i) => {
      const r = report.connections[i];
      const status = r.verified ? 'TRAFFIC VERIFIED' : c.state === 'configured' ? 'CONNECTED — WAITING FOR TRAFFIC' : c.state.toUpperCase();
      console.log(`\n${i + 1}. ${LABELS[c.client]} · ${JSON.stringify(c.name)} · ${status}`);
      console.log(`   ${JSON.stringify(c.file)} (${c.scope.startsWith('project:') ? 'project' : c.scope.startsWith('local:') ? 'local project' : c.scope})`);
      console.log(`   ${c.reason}`);
      if (c.state === 'configured') console.log(`   ${r.responses} tool responses in 7 days; ${r.errors} errors; capture ${r.capture}.`);
      if (r.toolsUsed.length) console.log(`   Tools observed: ${r.toolsUsed.map((t) => JSON.stringify(t)).join(', ')}`);
      if (has('--discover')) console.log(`   Selection ID: ${c.id}`);
    });
    for (const f of found.files.filter((f) => f.state.startsWith('unreadable') || f.state.startsWith('missing'))) console.log(`\nNeeds attention: ${JSON.stringify(f.file)} — ${f.state}`);
    if (unreadableHomes) console.log('\nSome private activity stores could not be read. Coverage cannot be established for those connections.');
    console.log('\nCoverage limits:'); for (const limit of found.limits) console.log(`  ${limit}`);
    if (!found.connections.length) console.log('\nNo connections found. If you use tools inside a project, rerun with --project /your/folder. For a custom app profile use --config client=/path. Cloud tools and built-in tools need another integration; this install cannot discover them.');
    if (readOnly) {
      if (has('--check')) {
        const verified = report.connections.filter((c) => c.verified).length;
        console.log(`\n${verified}/${found.connections.length} discovered connections have verified traffic. This is not a percentage of all your tools.`);
        console.log('For waiting connections: restart that app, approve its MCP connection if prompted, then ask it to use the named tool in a normal task. Rerun this check afterward.');
        if (!verified || report.connections.some((c) => !c.verified) || unreadableHomes || found.files.some((f) => f.state.startsWith('unreadable') || f.state.startsWith('missing'))) process.exitCode = 2;
      }
      return;
    }
    const available = found.connections.filter((c) => c.state === 'available');
    if (!available.length) { console.log('\nNo new supported connections to install. Use --check to verify existing ones.'); return; }
    let selected = available;
    if (opts.has('--only')) { const ids = opts.get('--only')!; selected = available.filter((c) => ids.includes(c.id)); if (selected.length !== new Set(ids).size) throw new Error('A selected ID is unavailable. Rescan with --discover.'); }
    if (rl) {
      console.log('\nConnecting changes the selected app configuration files, including project files. Close those apps first. Originals are backed up privately and can be restored with --undo. No tools run during setup.');
      const answer = (await rl.question('Connect all AVAILABLE connections? Enter yes, connection numbers separated by commas, or no: ')).trim().toLowerCase();
      if (answer === 'no' || !answer) { console.log('Nothing changed.'); return; }
      if (answer !== 'yes') {
        const nums = answer.split(',').map((s) => Number(s.trim()));
        if (nums.some((n) => !Number.isInteger(n) || n < 1 || n > found.connections.length || found.connections[n - 1].state !== 'available')) throw new Error('Choose only the numbers marked AVAILABLE. Nothing changed.');
        selected = [...new Set(nums)].map((n) => found.connections[n - 1]);
      }
    } else if (!has('--yes')) { console.log('\nNothing changed. Run in an interactive terminal, or choose --yes --all-supported.'); return; }
    let autowrite = has('--autowrite');
    if (rl && !autowrite) autowrite = /^(y|yes)$/i.test((await rl.question('Automatically remember supported tool problems in your private corpus? [y/N]: ')).trim());
    const count = connect(selected, { root, home, stateDir: dir, projects: found.projects, autowrite });
    console.log(`\nConnected ${count} tool connections. Restart the affected apps and accept their connection/trust prompts.`);
    console.log('Ask each app to use one of the tools above for normal work. Then run: npm run cairn:setup -- --check');
    console.log(autowrite ? 'Capture is on: completed candidates are checked after 60 seconds without an active tool call, or when the connection closes. It does not run checks or share findings.' : 'Automatic capture is off. Cairn still routes calls and supplies relevant existing findings.');
    console.log('Undo: npm run cairn:setup -- --undo\nOptional anonymous feedback: npm run --silent cairn:setup -- --share > cairn-coverage.json');
  } finally { rl?.close(); }
}
main().catch((e) => { console.error(`Cairn setup: ${e instanceof Error ? e.message : 'Setup failed.'}\nIf setup was interrupted, preserve the private recovery records and run --undo. No configurations are automatically discarded.`); process.exitCode = 1; });
