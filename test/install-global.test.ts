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

function fixture(): { home: string; claudeJson: string; claudeMd: string; settings: string; corpus: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-install-'));
  fs.mkdirSync(path.join(home, '.claude'));
  const claudeJson = path.join(home, '.claude.json');
  const claudeMd = path.join(home, '.claude', 'CLAUDE.md');
  const settings = path.join(home, '.claude', 'settings.json');
  fs.writeFileSync(
    claudeJson,
    JSON.stringify({ mcpServers: { 'sf-all': { command: 'npx', args: ['-y', 'x'] } }, keep: true }, null, 2),
  );
  fs.writeFileSync(claudeMd, '# my notes\n\nexisting.\n');
  /* A pre-existing hook and an unrelated setting the install must not disturb. */
  fs.writeFileSync(
    settings,
    JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] }, theme: 'dark' }, null, 2),
  );
  return { home, claudeJson, claudeMd, settings, corpus: path.join(home, 'pilot') };
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

test('install registers both sleep hooks and preserves existing ones', () => {
  const f = fixture();
  run(f.home, ['--home', f.corpus]);

  const s = JSON.parse(fs.readFileSync(f.settings, 'utf8'));
  const end = s.hooks.SessionEnd.map((g: { hooks: { command: string }[] }) => g.hooks[0].command);
  const start = s.hooks.SessionStart.map((g: { hooks: { command: string }[] }) => g.hooks[0].command);
  assert.ok(end.some((c: string) => c.includes('cairn-sleep.js') && c.includes('--hook')), 'SessionEnd runs the consolidation pass');
  assert.ok(start.some((c: string) => c.includes('cairn-sleep.js') && c.includes('--surface')), 'SessionStart surfaces candidates');
  assert.ok(start.some((c: string) => c.includes('cairn-triage-trigger.js')), 'SessionStart also fires the triage trigger');
  assert.ok(end.every((c: string) => c.includes(f.corpus)), 'the hook carries the corpus home');
  assert.ok(start.some((c: string) => c === 'echo mine'), 'the pre-existing hook survives');
  assert.equal(s.theme, 'dark', 'unrelated settings survive');
});

test('install is idempotent on hooks: twice does not duplicate', () => {
  const f = fixture();
  run(f.home, ['--home', f.corpus]);
  run(f.home, ['--home', f.corpus]);
  const s = JSON.parse(fs.readFileSync(f.settings, 'utf8'));
  const ours = (cmds: { hooks: { command: string }[] }[]) =>
    cmds.filter((g) => /cairn-sleep\.js|cairn-triage-trigger\.js/.test(g.hooks[0].command)).length;
  assert.equal(ours(s.hooks.SessionEnd), 1, 'exactly one SessionEnd group is ours');
  assert.equal(ours(s.hooks.SessionStart), 2, 'two SessionStart groups are ours: surface + trigger');
  assert.equal(s.hooks.SessionStart.length, 3, 'and the pre-existing one is still there');
  assert.match(run(f.home, ['--home', f.corpus]), /unchanged/, 'a third run reports unchanged');
});

test('uninstall removes exactly the sleep hooks it added', () => {
  const f = fixture();
  run(f.home, ['--home', f.corpus]);
  run(f.home, ['--uninstall']);
  const s = JSON.parse(fs.readFileSync(f.settings, 'utf8'));
  assert.ok(!('SessionEnd' in s.hooks), 'the empty SessionEnd key is cleaned up');
  assert.equal(s.hooks.SessionStart.length, 1, 'only the pre-existing hook remains');
  assert.equal(s.hooks.SessionStart[0].hooks[0].command, 'echo mine', 'and it is untouched');
  assert.equal(s.theme, 'dark', 'unrelated settings survive uninstall');
});

test('install generates the machine a signing identity, once', () => {
  const f = fixture();
  run(f.home, ['--home', f.corpus, '--author', 'joey.ahern']);

  const keys = fs.readdirSync(path.join(f.corpus, 'keys')).filter((n) => n.endsWith('.json'));
  assert.equal(keys.length, 1, 'a public key was generated and committed');
  const rec = JSON.parse(fs.readFileSync(path.join(f.corpus, 'keys', keys[0]), 'utf8'));
  assert.equal(rec.label, 'joey.ahern', 'under the given author label');
  const secrets = fs.readdirSync(path.join(f.corpus, '.cairn-secrets')).filter((n) => n.endsWith('.key'));
  assert.equal(secrets.length, 1, 'and the private half is kept in .cairn-secrets, never in keys/');

  /* Idempotent: re-running does not mint a second identity under the same label. */
  run(f.home, ['--home', f.corpus, '--author', 'joey.ahern']);
  assert.equal(fs.readdirSync(path.join(f.corpus, 'keys')).filter((n) => n.endsWith('.json')).length, 1, 'still one key');
});

test('--enable-execution turns on triage for this corpus only, off by default', () => {
  const f = fixture();
  const policy = path.join(f.home, '.cairn', 'policy.json');

  run(f.home, ['--home', f.corpus]); // no flag
  assert.ok(!fs.existsSync(policy), 'execution stays off unless asked — no policy written');

  run(f.home, ['--home', f.corpus, '--enable-execution']);
  const store = JSON.parse(fs.readFileSync(policy, 'utf8'));
  assert.equal(store[f.corpus].enabled, true, 'execution enabled for the installed corpus');
  assert.equal(Object.keys(store).length, 1, 'and only that corpus');
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
