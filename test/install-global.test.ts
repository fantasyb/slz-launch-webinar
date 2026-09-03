/**
 * The global install must be safe to run on a real person's machine: it edits
 * ~/.claude.json and the global instruction file, and the whole point is that a
 * fresh session in any directory then knows Cairn exists. So the properties that
 * matter are: it preserves everything it did not put there, it is idempotent, it
 * backs up before writing, and --uninstall removes exactly what it added.
 *
 * All of it runs against a throwaway HOME; nothing real is touched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const REPO = process.cwd();
const SCRIPT = path.join(REPO, 'scripts', 'install-global.ts');

function run(home: string, args: string[]): string {
  return execFileSync('npx', ['tsx', SCRIPT, ...args], {
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  });
}

function fixture(): { home: string; claudeJson: string; claudeMd: string; corpus: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-install-'));
  fs.mkdirSync(path.join(home, '.claude'));
  const claudeJson = path.join(home, '.claude.json');
  const claudeMd = path.join(home, '.claude', 'CLAUDE.md');
  fs.writeFileSync(
    claudeJson,
    JSON.stringify({ mcpServers: { 'sf-all': { command: 'npx', args: ['-y', 'x'] } }, keep: true }, null, 2),
  );
  fs.writeFileSync(claudeMd, '# my notes\n\nexisting.\n');
  return { home, claudeJson, claudeMd, corpus: path.join(home, 'pilot') };
}

test('install adds the server and the block, and preserves everything else', () => {
  const f = fixture();
  run(f.home, ['--home', f.corpus]);

  const cfg = JSON.parse(fs.readFileSync(f.claudeJson, 'utf8'));
  assert.equal(cfg.mcpServers.cairn.command, 'node', 'the cairn server is registered');
  assert.match(cfg.mcpServers.cairn.args[0], /bin\/cairn-mcp\.js$/);
  assert.equal(cfg.mcpServers.cairn.env.CAIRN_HOME, f.corpus, 'with the corpus home');
  assert.ok(cfg.mcpServers['sf-all'], 'the existing server survives');
  assert.equal(cfg.keep, true, 'unrelated settings survive');

  const md = fs.readFileSync(f.claudeMd, 'utf8');
  assert.match(md, /^# my notes/, 'existing instructions survive, and first');
  assert.match(md, /this is not memory/, 'the block declares itself not-memory');
  assert.match(md, /cairn_find/, 'and names the tool to call');
  assert.ok(fs.existsSync(path.join(f.corpus, 'cairn')), 'the corpus dir is created');
});

test('install is idempotent: twice is the same as once', () => {
  const f = fixture();
  run(f.home, ['--home', f.corpus]);
  run(f.home, ['--home', f.corpus]);

  const md = fs.readFileSync(f.claudeMd, 'utf8');
  assert.equal((md.match(/cairn:begin/g) ?? []).length, 1, 'exactly one managed block');
  const cfg = JSON.parse(fs.readFileSync(f.claudeJson, 'utf8'));
  assert.equal(Object.keys(cfg.mcpServers).filter((k) => k === 'cairn').length, 1, 'exactly one server entry');
  assert.match(run(f.home, ['--home', f.corpus]), /unchanged/, 'a third run reports unchanged');
});

test('dry-run writes nothing', () => {
  const f = fixture();
  const before = fs.readFileSync(f.claudeJson, 'utf8') + fs.readFileSync(f.claudeMd, 'utf8');
  const out = run(f.home, ['--home', f.corpus, '--dry-run']);
  const after = fs.readFileSync(f.claudeJson, 'utf8') + fs.readFileSync(f.claudeMd, 'utf8');
  assert.equal(after, before, 'no file changed');
  assert.match(out, /Nothing was written/);
});

test('install backs up before it writes', () => {
  const f = fixture();
  run(f.home, ['--home', f.corpus]);
  const backups = fs.readdirSync(path.join(f.home, '.claude')).filter((n) => n.includes('.cairn-bak-'));
  assert.ok(backups.length >= 1, 'the instruction file was backed up before editing');
});

test('uninstall removes exactly what was added', () => {
  const f = fixture();
  run(f.home, ['--home', f.corpus]);
  run(f.home, ['--uninstall']);

  const cfg = JSON.parse(fs.readFileSync(f.claudeJson, 'utf8'));
  assert.ok(!('cairn' in cfg.mcpServers), 'the cairn server is gone');
  assert.ok(cfg.mcpServers['sf-all'], 'the other server remains');
  const md = fs.readFileSync(f.claudeMd, 'utf8');
  assert.ok(!md.includes('cairn:begin'), 'the block is gone');
  assert.match(md, /^# my notes/, 'the original notes remain');
});

test('a home inside the code checkout is refused', () => {
  const f = fixture();
  let threw = false;
  try {
    run(f.home, ['--home', path.join(REPO, 'inside')]);
  } catch {
    threw = true;
  }
  assert.ok(threw, 'a corpus inside the repo that git pull would destroy is refused');
});

test('malformed ~/.claude.json is refused, not clobbered', () => {
  const f = fixture();
  fs.writeFileSync(f.claudeJson, '{ not json');
  let threw = false;
  try {
    run(f.home, ['--home', f.corpus]);
  } catch {
    threw = true;
  }
  assert.ok(threw, 'refused');
  assert.equal(fs.readFileSync(f.claudeJson, 'utf8'), '{ not json', 'and left untouched');
});

test('a config with a too-large integer is refused, not silently corrupted', () => {
  const f = fixture();
  fs.writeFileSync(f.claudeJson, '{"numStartups":9007199254740993,"mcpServers":{}}');
  let threw = false;
  try {
    run(f.home, ['--home', f.corpus]);
  } catch {
    threw = true;
  }
  assert.ok(threw, 'refused rather than round-tripping through JSON');
  assert.match(fs.readFileSync(f.claudeJson, 'utf8'), /9007199254740993/, 'the number is untouched on disk');
});

test('malformed markers (an interrupted prior run) are refused, not duplicated', () => {
  const f = fixture();
  fs.writeFileSync(f.claudeMd, `# notes\n\n${'<!-- cairn:begin (managed by `npm run cairn:install` — edits between these markers are overwritten) -->'}\norphan junk\n`);
  let threw = false;
  try {
    run(f.home, ['--home', f.corpus]);
  } catch {
    threw = true;
  }
  assert.ok(threw, 'refused a lone begin marker');
  assert.equal((fs.readFileSync(f.claudeMd, 'utf8').match(/cairn:begin/g) ?? []).length, 1, 'no second block appended');
});
