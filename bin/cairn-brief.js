#!/usr/bin/env node
/**
 * Launcher for the brief — findings handed over before work starts.
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

const bundle = path.join(__dirname, '..', 'dist', 'cli', 'brief.js');
if (fs.existsSync(bundle)) {
  require(bundle);
} else {
  const { spawn } = require('child_process');
  spawn('npx', ['tsx', path.join(__dirname, '..', 'scripts', 'brief.ts'), ...process.argv.slice(2)], {
    stdio: 'inherit',
  }).on('exit', (c) => process.exit(c ?? 0));
}
