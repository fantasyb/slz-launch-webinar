#!/usr/bin/env node
/** A Stop hook: broadcast a new generation to this corpus's local gateways.
 * No transcript input, network, execution of findings, or model output. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function requestFlush(home) {
  if (!home || !path.isAbsolute(home) || !fs.statSync(path.join(home, 'cairn')).isDirectory()) return;
  const dir = path.join(home, 'data');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.flush-${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmp, crypto.randomUUID(), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, path.join(dir, 'flush-signal'));
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* renamed, or never created */ }
  }
}

module.exports = { requestFlush };
if (require.main === module) {
  const i = process.argv.indexOf('--home');
  try { requestFlush(i < 0 ? process.env.CAIRN_HOME : process.argv[i + 1]); }
  catch { process.stderr.write('Cairn could not signal task completion; pending evidence remains local.\n'); }
  // The hook never asks Claude to continue or blocks the user's task.
}
