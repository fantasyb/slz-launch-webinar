#!/usr/bin/env node
/** Read-only session readiness probe. Never launches configured upstreams. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

function readConfig(config) {
  if (fs.statSync(config).size > 4 * 1024 * 1024) throw new Error('oversized');
  const parsed = JSON.parse(fs.readFileSync(config, 'utf8'));
  if (!parsed?.mcpServers || typeof parsed.mcpServers !== 'object' || Array.isArray(parsed.mcpServers)) throw new Error('missing servers');
  return parsed.mcpServers;
}

function configuredHome(config) {
  try {
    const home = readConfig(config).cairn?.env?.CAIRN_HOME;
    return typeof home === 'string' && path.isAbsolute(home) ? home : undefined;
  } catch { return undefined; }
}

/** Inspect registration only. Never launch an upstream or print its credentials. */
function gatewaySetup({ root, home, config }) {
  let entries;
  try { entries = readConfig(config); } catch { return []; }
  return Object.entries(entries).filter(([name]) => name !== 'cairn').map(([name, entry]) => {
    const args = Array.isArray(entry?.args) ? entry.args : [];
    const wrapped = args.some((a) => typeof a === 'string' && path.basename(a) === 'cairn-proxy.js');
    if (!wrapped) return { name, state: 'direct', reason: typeof entry?.url === 'string' ? 'http-not-wrapped' : 'not-wrapped', autowrite: false };
    const base = { name, state: 'broken', reason: 'gateway-registration', autowrite: entry?.env?.CAIRN_AUTOWRITE === '1' };
    if (!['node', process.execPath].includes(entry?.command) || args[0] !== path.join(root, 'bin', 'cairn-proxy.js') || entry?.env?.CAIRN_HOME !== home) return base;
    const i = args.indexOf('--config');
    const stash = args[i + 1];
    if (i < 0 || typeof stash !== 'string' || !home || path.resolve(stash) !== path.join(path.resolve(home), 'wrapped', `${name}.json`)) return base;
    try {
      const st = fs.statSync(stash);
      if (!st.isFile() || st.size > 4 * 1024 * 1024) return { ...base, reason: 'stash-unreadable' };
      const original = readConfig(stash)[name];
      if (!original || (typeof original.command !== 'string' && typeof original.url !== 'string')) return { ...base, reason: 'stash-unreadable' };
      if (process.platform !== 'win32' && (st.mode & 0o077)) return { ...base, reason: 'stash-permissions' };
      if (!fs.existsSync(path.join(root, 'dist', 'cli', 'mcp-proxy.js'))) return { ...base, reason: 'gateway-build-missing' };
      return { ...base, state: 'wrapped', reason: 'configured' };
    } catch { return { ...base, reason: 'stash-unreadable' }; }
  });
}

function probe(server, home, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let child, done = false, bytes = 0, pending = '';
    const finish = (ok) => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (child) { child.stdin.destroy(); child.stdout.destroy(); child.kill('SIGKILL'); }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      child = spawn(process.execPath, [server], {
        env: { ...process.env, CAIRN_HOME: home }, stdio: ['pipe', 'pipe', 'ignore'],
      });
      const send = (value) => child.stdin.write(JSON.stringify(value) + '\n');
      child.on('error', () => finish(false));
      child.on('exit', () => finish(false));
      child.stdin.on('error', () => finish(false));
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        if (done) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > 1024 * 1024) return finish(false);
        pending += chunk;
        let newline;
        while (!done && (newline = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
          try {
            const msg = JSON.parse(line);
            if (msg.id === 1) {
              if (!msg.result?.protocolVersion || msg.error) return finish(false);
              send({ jsonrpc: '2.0', method: 'notifications/initialized' });
              send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
            } else if (msg.id === 2) {
              finish(!msg.error && Array.isArray(msg.result?.tools)
                && msg.result.tools.some((tool) => tool.name === 'cairn_find'));
            }
          } catch { finish(false); }
        }
      });
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'cairn-health', version: '1' },
      } });
    } catch { finish(false); }
  });
}

async function health({ root, home, config }) {
  const issues = [];
  try {
    const server = readConfig(config).cairn;
    if (!server || !['node', process.execPath].includes(server.command)
      || !Array.isArray(server.args) || server.args.length !== 1
      || server.args[0] !== path.join(root, 'bin', 'cairn-mcp.js')
      || server.env?.CAIRN_HOME !== home) issues.push('Cairn registration is missing or points elsewhere; rerun the approved installer.');
  } catch { issues.push('Claude configuration cannot be verified; rerun the approved installer after checking it.'); }
  try { if (!fs.statSync(path.join(home, 'cairn')).isDirectory()) throw new Error('not directory'); }
  catch { issues.push('The Cairn corpus directory is unavailable.'); }
  const server = path.join(root, 'dist', 'cli', 'mcp-server.js');
  if (!fs.existsSync(server)) issues.push('The Cairn build is missing; rebuild the approved checkout.');
  if (!issues.length && !await probe(server, home)) issues.push('Cairn did not answer its bounded startup probe; check its installation.');
  const gateways = gatewaySetup({ root, home, config });
  const ready = issues.length === 0;
  return { ready, gatewayReady: ready && gateways.some((g) => g.state === 'wrapped') && !gateways.some((g) => g.state === 'broken'),
    containment: 'not-verified-by-this-check', issues, gateways };
}

async function main() {
  const args = process.argv.slice(2);
  const value = (flag, fallback) => { const i = args.indexOf(flag); return i < 0 ? fallback : args[i + 1]; };
  let result;
  try {
    const config = value('--claude-json', path.join(os.homedir(), '.claude.json'));
    result = await health({ root: path.resolve(__dirname, '..'), home: value('--home', process.env.CAIRN_HOME || configuredHome(config)), config });
  } catch { result = { ready: false, containment: 'not-verified-by-this-check', issues: ['Cairn setup could not be verified.'] }; }
  if (args.includes('--json')) console.log(JSON.stringify(result));
  else if (!result.ready) console.log('Cairn needs attention: ' + result.issues.join(' '));
  else if (result.gateways?.some((g) => g.state === 'broken')) console.log('Cairn gateway setup needs attention. Run npm run cairn:pilot in the Cairn checkout.');
  else if (!args.includes('--hook')) console.log(result.gatewayReady ? 'Cairn is configured. Run npm run cairn:pilot to check real traffic.' : 'Cairn tools are available, but no gateway is configured. Run npm run cairn:pilot.');
  // An unavailable memory service must not prevent opening Claude Code.
  if (!args.includes('--hook') && !result.ready) process.exitCode = 1;
}
module.exports = { probe, health, gatewaySetup, configuredHome };
if (require.main === module) main();
