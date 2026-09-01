#!/usr/bin/env node
/**
 * Launcher for recording — an agent writes a finding from another project.
 *
 * The bundle is `require`d, not spawned. The first version of this shelled out
 * to `node dist/cli/find.js`, which meant two node boots for one query -- the
 * launcher's and the bundle's -- and turned a 60ms saving into a 30ms one.
 *
 * Falls back to tsx when nothing has been built, so a fresh clone works before
 * `cairn:build-cli` has ever run. Slower, but a tool consulted during
 * confusing failures must not itself become one.
 */
const fs = require('fs');
const path = require('path');

const bundle = path.join(__dirname, '..', 'dist', 'cli', 'record.js');
if (fs.existsSync(bundle)) {
  require(bundle);
} else {
  const { spawn } = require('child_process');
  spawn('npx', ['tsx', path.join(__dirname, '..', 'scripts', 'record.ts'), ...process.argv.slice(2)], {
    stdio: 'inherit',
  }).on('exit', (c) => process.exit(c ?? 0));
}
