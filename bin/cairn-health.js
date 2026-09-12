#!/usr/bin/env node
/** Read-only session readiness probe. Never launches configured upstreams. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

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
    const stat = fs.statSync(config);
    if (stat.size > 4 * 1024 * 1024) throw new Error('oversized');
    const server = JSON.parse(fs.readFileSync(config, 'utf8')).mcpServers?.cairn;
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
  return { ready: issues.length === 0, containment: 'not-verified-by-this-check', issues };
}

async function main() {
  const args = process.argv.slice(2);
  const value = (flag, fallback) => { const i = args.indexOf(flag); return i < 0 ? fallback : args[i + 1]; };
  let result;
  try {
    result = await health({ root: path.resolve(__dirname, '..'), home: value('--home', process.env.CAIRN_HOME),
      config: value('--claude-json', path.join(os.homedir(), '.claude.json')) });
  } catch { result = { ready: false, containment: 'not-verified-by-this-check', issues: ['Cairn setup could not be verified.'] }; }
  if (args.includes('--json')) console.log(JSON.stringify(result));
  else if (!result.ready) console.log('Cairn needs attention: ' + result.issues.join(' '));
  // An unavailable memory service must not prevent opening Claude Code.
  if (!args.includes('--hook') && !result.ready) process.exitCode = 1;
}
module.exports = { probe, health };
if (require.main === module) main();
