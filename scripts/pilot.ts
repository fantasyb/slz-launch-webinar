/** Read-only pilot diagnosis; no upstream is started and nothing is uploaded. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { health, configuredHome } from '../bin/cairn-health.js';
import { setCairnHome, installRoot } from '../src/lib/cairn/home';
import { readLedger } from '../src/lib/cairn/ledger';
import { pilotSummary, sharePilotReport } from '../src/lib/cairn/pilot';

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('cairn:pilot [--days 7] [--json | --share] [--home /absolute/corpus] [--claude-json /absolute/config]\nRead-only. --share prints anonymous aggregate JSON; it does not send anything.');
    return;
  }
  const opt = (name: string, fallback: string) => {
    const i = args.indexOf(name);
    if (i === -1) return fallback;
    if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${name} needs a value`);
    return args[i + 1];
  };
  const days = Number(opt('--days', '7'));
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error('--days must be an integer from 1 to 90');
  const config = path.resolve(opt('--claude-json', path.join(os.homedir(), '.claude.json')));
  const home = path.resolve(opt('--home', process.env.CAIRN_HOME || configuredHome(config) || path.join(os.homedir(), '.cairn', 'corpus')));
  const root = installRoot() || process.cwd();
  const setup = await health({ root, home, config });
  let rows: ReturnType<typeof readLedger> = [];
  if (fs.existsSync(path.join(home, 'cairn'))) { setCairnHome(home); rows = readLedger(); }
  const summary = pilotSummary(rows, setup.gateways, days);
  let revision = 'unknown';
  try { revision = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* packaged without git */ }
  if (args.includes('--share')) {
    console.log(JSON.stringify({ ...sharePilotReport(summary), revision, gatewayReady: setup.gatewayReady }, null, 2));
    return;
  }
  if (args.includes('--json')) {
    console.log(JSON.stringify({ revision, setup, summary }, null, 2));
  } else {
    console.log(`Cairn pilot · ${revision} · last ${days} days`);
    console.log(setup.gatewayReady ? 'Gateway configuration: ready (live traffic listed below).' : 'Gateway configuration: needs attention.');
    for (const issue of setup.issues) console.log(`  ${issue}`);
    if (!summary.connections.length) console.log('  No tool servers found in this Claude Code user config. Add a supported MCP server, then rerun cairn:install.');
    for (const c of summary.connections) {
      console.log(`  ${JSON.stringify(c.name)}: ${c.state} · ${c.calls} calls · ${c.errors} errors · capture ${c.autowrite ? 'on' : 'off'}`);
      if (c.state === 'direct') console.log('    Outside Cairn. Headerless/OAuth HTTP servers are left direct; project-scoped servers need separate setup.');
      if (c.state === 'broken') console.log(`    ${c.reason}; check the installation and rerun cairn:install.`);
      if (c.state === 'wrapped' && !c.lastCallAt) console.log('    No live traffic observed yet. Restart Claude Code and use this tool in a normal task.');
      if (c.lastCallAt) console.log(`    Last call ${c.lastCallAt}; p95 observed call time ${c.p95CallMs} ms (includes upstream time).`);
    }
    console.log(`Result annotations: ${summary.resultAnnotations} (${summary.resultPatternMatches} matched a result pattern, ${summary.broadToolMatches} matched the tool, ${summary.unknownMatchReason} historical/unknown).`);
    console.log(`Findings auto-written: ${summary.autoWritten}; capture candidates rejected: ${summary.captureRejected}.`);
    if (summary.legacyCalls || summary.otherConnectionCalls) console.log(`Unassigned calls: ${summary.legacyCalls} historical, ${summary.otherConnectionCalls} from other/previous connections.`);
    console.log('Task correctness and token savings: not measured. Calls outside Cairn are not visible.');
    console.log('To share anonymous counts: npm run --silent cairn:pilot -- --share > cairn-pilot-report.json');
  }
  if (!setup.gatewayReady) process.exitCode = 1;
}
main().catch(() => { console.error('Pilot check failed. Use --help and check your corpus/config paths and --days value.'); process.exitCode = 1; });
