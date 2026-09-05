/**
 * The launchd LaunchAgent plist. The installer writes this string and hands it to
 * launchctl, so its contract is exactly what "always on" means on macOS: it
 * launches the daemon with the right corpus and interval, starts at login, and is
 * kept alive if it dies. These pin that contract without needing a Mac.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plistContent, plistPath, LAUNCHD_LABEL } from '../src/lib/cairn/launchd';

const base = {
  nodeBin: '/usr/local/bin/node',
  daemonBin: '/repo/bin/cairn-daemon.js',
  home: '/Users/you/pilot',
  intervalSeconds: 300,
  logPath: '/Users/you/pilot/drafts/daemon.log',
};

test('the plist launches the daemon with this corpus and interval', () => {
  const xml = plistContent(base);
  assert.match(xml, /<key>Label<\/key>\s*<string>com\.cairn\.daemon<\/string>/, 'labelled com.cairn.daemon');
  assert.ok(xml.includes('<string>/repo/bin/cairn-daemon.js</string>'), 'runs the daemon bin');
  assert.ok(xml.includes('<string>/usr/local/bin/node</string>'), 'via the resolved node');
  assert.ok(xml.includes('<string>--home</string>'), 'passes --home');
  assert.ok(xml.includes('<string>/Users/you/pilot</string>'), 'the corpus');
  assert.ok(xml.includes('<string>--interval</string>'), 'passes --interval');
  assert.ok(xml.includes('<string>300</string>'), 'the interval seconds');
});

test('it starts at login and is kept alive if it dies', () => {
  const xml = plistContent(base);
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/, 'RunAtLoad so it starts at login');
  assert.match(xml, /<key>KeepAlive<\/key>\s*<true\/>/, 'KeepAlive so a crash is restarted');
});

test('CAIRN_HOME is set for the process and logs go to the corpus', () => {
  const xml = plistContent(base);
  assert.match(xml, /<key>CAIRN_HOME<\/key>\s*<string>\/Users\/you\/pilot<\/string>/, 'CAIRN_HOME in the environment');
  assert.ok(xml.includes('<string>/Users/you/pilot/drafts/daemon.log</string>'), 'stdout+stderr to the corpus log');
  assert.match(xml, /<key>StandardOutPath<\/key>/, 'stdout captured');
  assert.match(xml, /<key>StandardErrorPath<\/key>/, 'stderr captured');
});

test('it is well-formed and XML-escapes paths', () => {
  const xml = plistContent({ ...base, home: '/Users/you/a & b/pilot' });
  assert.ok(xml.startsWith('<?xml'), 'has the XML prolog');
  assert.ok(xml.includes('<!DOCTYPE plist'), 'has the plist doctype');
  assert.ok(xml.includes('/Users/you/a &amp; b/pilot'), 'ampersand escaped, not left raw');
  assert.ok(!/&(?!amp;|lt;|gt;|quot;)/.test(xml), 'no unescaped ampersands anywhere');
});

test('extra env (a PATH for launchd) is rendered alongside CAIRN_HOME', () => {
  const xml = plistContent({ ...base, env: { PATH: '/opt/homebrew/bin:/usr/bin:/bin' } });
  assert.match(xml, /<key>CAIRN_HOME<\/key>\s*<string>\/Users\/you\/pilot<\/string>/, 'CAIRN_HOME still present');
  assert.match(xml, /<key>PATH<\/key>\s*<string>\/opt\/homebrew\/bin:\/usr\/bin:\/bin<\/string>/, 'PATH rendered so launchd can find node/npx/claude');
});

test('the plist lives at ~/Library/LaunchAgents and is named for the label', () => {
  const p = plistPath('/Users/you');
  assert.equal(p, `/Users/you/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`);
});
