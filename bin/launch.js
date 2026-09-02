/**
 * Bundle or source, decided once, for every cairn-* launcher.
 *
 * The bundle is `require`d rather than spawned: shelling out to
 * `node dist/cli/<x>.js` meant two node boots for one query -- the launcher's
 * and the bundle's -- and turned a 60ms saving into a 30ms one.
 *
 * THREE CASES, and the third is the one that was missing:
 *
 *   no bundle      run the TypeScript through tsx. A fresh clone works before
 *                  `cairn:build-cli` has ever run. Slower, but a tool consulted
 *                  during confusing failures must not itself become one.
 *
 *   fresh bundle   require it. The fast path, and the normal one.
 *
 *   STALE bundle   run the source instead, and say so. A stale dist/ has now
 *                  defeated three fixes in this project: the guard grew its own
 *                  refusal after two of them, but the launchers -- the thing a
 *                  person actually runs -- required whatever was there. `npm
 *                  test` spawns tsx and never touches the bundle, so a source
 *                  fix can be green in CI, green in review, and absent from
 *                  every real invocation. It hid a --quiet flag, it hid
 *                  CAIRN_EVAL while the guard wrote eval traffic into the usage
 *                  ledger, and it would have hidden a redaction pattern from a
 *                  gateway pointed at production data.
 *
 * Stale means slower, never wrong, and never fatal: the gateway in particular
 * must not refuse to start over its own build state -- see cairn-0046.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** Newest mtime under a directory, or 0 if it is not there. */
function newest(dir) {
  let max = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      max = Math.max(max, e.isDirectory() ? newest(p) : fs.statSync(p).mtimeMs);
    } catch {
      /* raced with a write; not worth failing a launch over */
    }
  }
  return max;
}

function launch(name) {
  const bundle = path.join(ROOT, 'dist', 'cli', `${name}.js`);
  const source = path.join(ROOT, 'scripts', `${name}.ts`);

  if (fs.existsSync(bundle)) {
    /*
     * Only the sources a bundle is actually built from. Walking the whole repo
     * would make every corpus edit look like a code change, and this runs on
     * every invocation of a command whose whole point is being fast enough to
     * consult without thinking about it.
     */
    const built = fs.statSync(bundle).mtimeMs;
    const src = Math.max(newest(path.join(ROOT, 'src', 'lib', 'cairn')), newest(path.join(ROOT, 'scripts')));
    if (src <= built) {
      require(bundle);
      return;
    }
    process.stderr.write(
      `cairn: dist/cli/${name}.js is older than src/ — running the source instead.\n` +
        '      Correct, but slower. Rebuild with: npm run cairn:build-cli\n',
    );
  }

  const { spawn } = require('child_process');
  spawn('npx', ['tsx', source, ...process.argv.slice(2)], { stdio: 'inherit' }).on('exit', (c) =>
    process.exit(c ?? 0),
  );
}

module.exports = { launch };
