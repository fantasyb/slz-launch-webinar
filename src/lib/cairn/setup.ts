/** Discovery is read-only and never launches a client, upstream, or login. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { atPath, editEntry, object, parseConfig, readText, type ObjectValue, type ConfigFormat } from './setup-config';
import type { RetrievalRecord } from './ledger';
import { oauthFile, oauthUrl, readOAuth } from './oauth';

export const CLIENTS = ['claude', 'desktop', 'cursor', 'windsurf', 'vscode', 'codex'] as const;
export type ClientKind = typeof CLIENTS[number];
export const LABELS: Record<ClientKind, string> = { claude: 'Claude Code', desktop: 'Claude Desktop', cursor: 'Cursor', windsurf: 'Windsurf', vscode: 'VS Code', codex: 'Codex' };
export interface Target { client: ClientKind; file: string; scope: string; keys: string[]; format: ConfigFormat }
export interface Connection extends Target { id: string; name: string; state: 'available' | 'configured' | 'changed' | 'manual' | 'disabled' | 'legacy'; reason: string; entry: ObjectValue; fingerprint: string }
export interface SavedConnection extends Target { id: string; name: string; original: ObjectValue; installed: ObjectValue; revision: string; home: string; installedAt: string }
export interface Manifest { version: 1; projects: string[]; connections: SavedConnection[] }
export interface Discovery { connections: Connection[]; files: Array<{ file: string; client: ClientKind; state: string }>; projects: string[]; limits: string[] }
export const stateRoot = () => path.join(os.homedir(), '.cairn', 'setup');
export const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const encode = (v: unknown) => JSON.stringify(v);
const equal = isDeepStrictEqual;
const clientFile = (client: ClientKind, file: string, scope: string, keys?: string[]): Target => ({ client, file: path.resolve(file), scope, format: client === 'codex' ? 'toml' : 'jsonc', keys: keys ?? [client === 'codex' ? 'mcp_servers' : client === 'vscode' ? 'servers' : 'mcpServers'] });
export function readManifest(dir: string): Manifest {
  const file = path.join(dir, 'manifest.json');
  if (!fs.existsSync(file)) return { version: 1, projects: [], connections: [] };
  try {
    const v = JSON.parse(readText(file));
    if (v.version !== 1 || !Array.isArray(v.projects) || !v.projects.every((p: unknown) => typeof p === 'string') || !Array.isArray(v.connections) || !v.connections.every((c: SavedConnection) => c && typeof c.id === 'string' && /^[a-f0-9]{24}$/.test(c.id) && CLIENTS.includes(c.client) && path.isAbsolute(c.file) && Array.isArray(c.keys) && c.keys.every((k) => typeof k === 'string') && object(c.original) && object(c.installed) && typeof c.home === 'string')) throw new Error('invalid');
    return v;
  } catch { throw new Error('Saved Cairn setup is unreadable. Preserve it for recovery; do not reinstall over it.'); }
}
const wrapped = (e: ObjectValue) => Array.isArray(e.args) && e.args.some((v) => typeof v === 'string' && /(?:^|[/\\])cairn-proxy\.js$/.test(v));
export const needsOAuth = (e: ObjectValue) => !e.command && typeof (e.url ?? e.serverUrl) === 'string' && (!object(e.headers ?? e.http_headers) || !Object.keys((e.headers ?? e.http_headers) as ObjectValue).length);
function unsupported(e: ObjectValue, client: ClientKind): string | undefined {
  if (e.disabled === true || e.enabled === false) return 'Disabled in this client.';
  if (wrapped(e)) return 'Previously installed gateway. Use its original installer to manage or remove it before guided setup.';
  const allowed = new Set(['command', 'args', 'env', 'cwd', 'type', 'url', 'serverUrl', 'headers', 'http_headers', 'disabled', 'enabled', 'autoApprove', 'alwaysAllow', 'timeout', 'startup_timeout_sec', 'startup_timeout_ms', 'tool_timeout_sec', 'enabled_tools', 'disabled_tools', 'env_vars', 'description']);
  if (Object.keys(e).some((k) => !allowed.has(k))) return 'Client-specific authentication, environment file, or execution settings need an adapter. Left unchanged.';
  if (e.cwd !== undefined && typeof e.cwd !== 'string') return 'Invalid working directory setting.';
  if (e.env !== undefined && (!object(e.env) || Object.entries(e.env).some(([k, v]) => k.startsWith('CAIRN_') || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || (typeof v !== 'string' && !(client === 'vscode' && (v === null || typeof v === 'number')))))) return 'Environment settings cannot be forwarded safely by this adapter.';
  if (e.env_vars !== undefined && (!Array.isArray(e.env_vars) || e.env_vars.some((v) => typeof v !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v) || v.startsWith('CAIRN_')))) return 'Remote or nonstandard environment forwarding needs manual setup.';
  if (typeof e.command === 'string' && e.command.trim() && !e.url && !e.serverUrl) {
    if (e.type !== undefined && e.type !== 'stdio') return 'Command and transport settings disagree.';
    if (e.args !== undefined && (!Array.isArray(e.args) || !e.args.every((a) => typeof a === 'string'))) return 'Arguments must be a list of strings.';
    return;
  }
  const url = e.url ?? e.serverUrl;
  if (typeof url === 'string' && !e.command) {
    if (e.type !== undefined && !['http', 'sse', 'streamable-http'].includes(String(e.type))) return 'Unsupported HTTP transport.';
    if (!/^https?:\/\//.test(url)) return 'Unsupported server URL.';
    const headers = e.headers ?? e.http_headers;
    if (headers === undefined || (object(headers) && !Object.keys(headers).length)) {
      try { oauthUrl(url); } catch { return 'Browser sign-in requires HTTPS or a local loopback URL.'; }
      return;
    }
    if (!object(headers)) return 'Unsupported HTTP header settings.';
    if (Object.entries(headers).some(([k, v]) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(k) || typeof v !== 'string' || /[\r\n]/.test(v))) return 'Unsupported HTTP header settings.';
    return;
  }
  return 'No supported local command or HTTP connection found.';
}
export function discover(options: { userHome?: string; platform?: NodeJS.Platform; projects?: string[]; extra?: Array<{ client: ClientKind; file: string }>; manifest?: Manifest } = {}): Discovery {
  const h = options.userHome ?? os.homedir(), platform = options.platform ?? process.platform;
  const m = options.manifest ?? { version: 1, projects: [], connections: [] };
  const projects = new Set([...m.projects, ...(options.projects ?? [])].map((p) => path.resolve(p)));
  const targets: Target[] = [clientFile('claude', path.join(h, '.claude.json'), 'user'), clientFile('cursor', path.join(h, '.cursor/mcp.json'), 'user'), clientFile('windsurf', path.join(h, '.codeium/windsurf/mcp_config.json'), 'user'), clientFile('codex', path.join(h, '.codex/config.toml'), 'user')];
  const appData = platform === 'darwin' ? path.join(h, 'Library/Application Support') : platform === 'win32' ? path.join(h, 'AppData/Roaming') : path.join(h, '.config');
  targets.push(clientFile('desktop', path.join(appData, 'Claude/claude_desktop_config.json'), 'user'), clientFile('vscode', path.join(appData, 'Code/User/mcp.json'), 'user'));
  // Claude records previously opened project roots. Read paths only; never walk
  // arbitrary directories or inspect project source/transcripts/credential stores.
  try {
    const cfg = parseConfig(readText(path.join(h, '.claude.json')), 'jsonc');
    if (object(cfg.projects)) for (const p of Object.keys(cfg.projects).slice(0, 200)) if (path.isAbsolute(p)) {
      projects.add(p);
      targets.push(clientFile('claude', path.join(h, '.claude.json'), `local: ${p}`, ['projects', p, 'mcpServers']));
    }
  } catch { /* surfaced as a configuration error below, if the file exists */ }
  for (const p of [...projects].slice(0, 200)) targets.push(clientFile('claude', path.join(p, '.mcp.json'), `project: ${p}`), clientFile('cursor', path.join(p, '.cursor/mcp.json'), `project: ${p}`), clientFile('vscode', path.join(p, '.vscode/mcp.json'), `project: ${p}`), clientFile('codex', path.join(p, '.codex/config.toml'), `project: ${p}`));
  for (const x of options.extra ?? []) targets.push(clientFile(x.client, x.file, 'custom'));
  for (const c of m.connections) targets.push({ client: c.client, file: c.file, keys: c.keys.slice(0, -1), format: c.format, scope: c.scope });
  const result: Discovery = { connections: [], files: [], projects: [...projects].slice(0, 200), limits: ['Only standard local config locations, saved connections, and selected/Claude-known projects are inspected (up to 200 project roots).', 'Built-in tools, direct API calls, cloud agents, remote hosts, plugins, managed policies, alternate profiles and undiscovered projects are outside this inventory.', 'Configuration does not establish routing. Only calls observed for this installed connection version verify traffic; client precedence and disabled-tool settings still apply.'] };
  const seen = new Set<string>();
  for (const t of targets) {
    const key = encode([t.file, t.keys]); if (seen.has(key)) continue; seen.add(key);
    if (!fs.existsSync(t.file)) { if (m.connections.some((c) => c.file === t.file)) result.files.push({ file: t.file, client: t.client, state: 'missing — previously managed configuration disappeared' }); continue; }
    try {
      const raw = readText(t.file), cfg = parseConfig(raw, t.format), servers = atPath(cfg, t.keys);
      if (servers === undefined) { result.files.push({ file: t.file, client: t.client, state: 'no servers in this scope' }); continue; }
      if (!object(servers)) throw new Error('Invalid server map');
      result.files.push({ file: t.file, client: t.client, state: 'read' });
      for (const [name, value] of Object.entries(servers)) {
        if (name === 'cairn' && object(value) && Array.isArray(value.args) && value.args.some((v) => typeof v === 'string' && /(?:^|[/\\])cairn-mcp\.js$/.test(v))) continue;
        const keys = [...t.keys, name], id = hash(encode([t.client, t.file, keys])).slice(0, 24);
        const saved = m.connections.find((c) => c.id === id);
        const entry = object(value) ? value : {};
        let reason = unsupported(entry, t.client), state: Connection['state'] = reason ? entry.disabled === true || entry.enabled === false ? 'disabled' : wrapped(entry) ? 'legacy' : 'manual' : 'available';
        if (saved) {
          state = equal(entry, saved.installed) ? 'configured' : 'changed';
          reason = state === 'configured' ? 'Restart the client and run a normal task to verify traffic.' : 'Configuration changed since setup. Existing call counts do not verify this version; inspect it before reconnecting.';
          const launcher = Array.isArray(saved.installed.args) ? saved.installed.args[0] : undefined;
          if (state === 'configured' && (typeof launcher !== 'string' || !fs.existsSync(launcher) || !fs.existsSync(path.join(path.dirname(String(launcher)), '../dist/cli/mcp-proxy.js')) || !fs.existsSync(path.join(saved.home, 'cairn')))) {
            state = 'changed'; reason = 'The gateway build or private corpus is missing. Restore the checkout/corpus before verifying this connection.';
          }
        }
        if (!saved) { try { assertWritableFile(t.file); editEntry(raw, t.format, keys, entry); } catch { state = 'manual'; reason = 'This file is linked, shared, read-only, or has a layout we cannot safely edit. Left unchanged.'; } }
        result.connections.push({ ...t, keys, id, name, entry, fingerprint: hash(raw), state, reason: reason ?? (needsOAuth(entry) ? 'Connection check and browser sign-in, if needed, are included in guided setup.' : 'Ready to connect.') });
      }
    } catch { result.files.push({ file: t.file, client: t.client, state: 'unreadable — fix syntax or permissions in the client and rescan' }); }
  }
  for (const c of m.connections) if (!result.connections.some((x) => x.id === c.id)) result.connections.push({ ...c, entry: {}, fingerprint: '', state: 'changed', reason: 'Previously connected server was removed or its configuration is unreadable.' });
  return result;
}
function publicConnection(c: Connection) {
  return { client: c.client, file: c.file, scope: c.scope, keys: c.keys, format: c.format, id: c.id, name: c.name, state: c.state, reason: c.reason };
}
export function publicDiscovery(d: Discovery) {
  return { ...d, connections: d.connections.map(publicConnection) };
}
export function coverage(d: Discovery, m: Manifest, records: RetrievalRecord[], now = Date.now()) {
  return { ...publicDiscovery(d), connections: d.connections.map((connection) => {
    const c = publicConnection(connection);
    const saved = m.connections.find((s) => s.id === c.id);
    let login = 'not required';
    const env = saved?.installed.env as ObjectValue | undefined;
    if (saved && typeof env?.CAIRN_OAUTH_FILE === 'string') {
      try { const r = readOAuth(env.CAIRN_OAUTH_FILE, String(saved.original.url ?? saved.original.serverUrl)); login = r.needsLogin ? 'sign-in required' : r.tokens ? 'credentials saved' : r.checkedAt ? 'public connection checked' : 'credentials need attention'; }
      catch { login = 'credentials need attention'; }
    }
    const seen = new Set<string>();
    const rows = records.filter((r) => {
      const at = Date.parse(r?.at), call = r?.call;
      if (c.state !== 'configured' || !saved || !call || !['mcp-proxy:call', 'mcp-proxy:error', 'mcp-proxy:cancelled'].includes(r.source ?? '') || call.connectionId !== c.id || call.connectionRevision !== saved.revision || !Number.isFinite(at) || at < now - 7 * 86400_000 || at > now || seen.has(call.id)) return false;
      seen.add(call.id); return true;
    });
    const reached = rows.filter((r) => ['tool-success', 'tool-error'].includes(r.call!.status));
    return { ...c, login, verified: reached.length > 0 && !['sign-in required', 'credentials need attention'].includes(login), attempts: rows.length, responses: reached.length, errors: rows.filter((r) => ['tool-error', 'transport-error'].includes(r.call!.status)).length,
      toolsUsed: [...new Set(reached.map((r) => r.call!.tool))].sort(), lastResponseAt: reached.map((r) => r.at).sort().at(-1) ?? null,
      capture: saved ? saved.installed.env && (saved.installed.env as ObjectValue).CAIRN_AUTOWRITE === '1' ? 'on after 60 seconds idle or session close' : 'off' : 'not managed' };
  }), windowDays: 7, allTrafficCovered: false };
}
export function anonymousCoverage(report: ReturnType<typeof coverage>) {
  return { format: 'cairn-coverage-v1', windowDays: report.windowDays, allTrafficCovered: false,
    unreadableFiles: report.files.filter((f) => f.state.startsWith('unreadable') || f.state.startsWith('missing')).length,
    connections: report.connections.map((c, i) => ({ alias: `connection-${i + 1}`, client: c.client, state: c.state, verified: c.verified, login: c.login, attempts: c.attempts, responses: c.responses, errors: c.errors, toolsUsedCount: c.toolsUsed.length, capture: c.capture })) };
}

/** Resolve only explicit environment names through the client. Command and args
 * stay separate strings in the client config, preserving its interpolation. */
export function wrapper(c: Connection, root: string, home: string, revision: string, autowrite: boolean, stateDir?: string): ObjectValue {
  const e = c.entry, next = { ...e }, args = [path.join(root, 'bin/cairn-proxy.js'), '--upstream-name', c.name];
  const env: ObjectValue = { ...(object(e.env) ? e.env : {}), CAIRN_HOME: home, CAIRN_TRUST_MODE: 'monitor', CAIRN_CONNECTION_ID: c.id, CAIRN_CONNECTION_REVISION: revision, CAIRN_CAPTURE_IDLE_MS: '60000', ...(autowrite ? { CAIRN_AUTOWRITE: '1' } : {}) };
  const pass = [...Object.keys(object(e.env) ? e.env : {}), ...(Array.isArray(e.env_vars) ? e.env_vars as string[] : [])];
  for (const name of new Set(pass)) args.push('--pass-env', name);
  if (typeof e.command === 'string') args.push('--stdio-command', e.command, '--', ...(e.args as string[] ?? []));
  else {
    args.push('--http-upstream', String(e.url ?? e.serverUrl));
    if (e.type === 'sse') args.push('--upstream-sse');
    const headers = (e.headers ?? e.http_headers ?? {}) as ObjectValue;
    Object.entries(headers).forEach(([name, value], i) => { const key = `CAIRN_UPSTREAM_HEADER_${i}`; env[key] = value; args.push('--header-env', name, key); });
    if (needsOAuth(e)) {
      if (!stateDir) throw new Error('OAuth connections require guided sign-in.');
      env.CAIRN_OAUTH_FILE = oauthFile(stateDir, c.id);
    }
  }
  for (const key of ['command', 'args', 'env', 'url', 'serverUrl', 'headers', 'http_headers', 'type']) delete next[key];
  return { ...next, ...(c.client !== 'codex' ? { type: 'stdio' } : {}), command: process.execPath, args, env };
}

function assertWritableFile(file: string): void {
  let p = path.resolve(file);
  while (true) { if (fs.lstatSync(p).isSymbolicLink()) throw new Error('Linked paths need manual setup.'); const parent = path.dirname(p); if (parent === p) break; p = parent; }
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.nlink !== 1 || !(st.mode & 0o200)) throw new Error('Shared, read-only or nonregular configuration needs manual setup.');
  fs.accessSync(file, fs.constants.W_OK);
}
function privateDir(dir: string): void {
  if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) throw new Error('Linked setup directories are unsupported.');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}
function writePrivate(file: string, data: string): void {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(tmp, data, { flag: 'wx', mode: 0o600 }); fs.renameSync(tmp, file); }
  finally { try { fs.unlinkSync(tmp); } catch { /* renamed */ } }
}
function replaceFile(file: string, expected: string, next: string): void {
  assertWritableFile(file);
  const mode = fs.statSync(file).mode & 0o777;
  const tmp = `${file}.cairn-${randomUUID()}.tmp`;
  try {
    // Private even if the old client config was world-readable.
    fs.writeFileSync(tmp, next, { flag: 'wx', mode: mode & 0o600 });
    if (readText(file) !== expected) throw new Error('Client configuration changed during setup. Close the client and rescan.');
    fs.renameSync(tmp, file);
  } finally { try { fs.unlinkSync(tmp); } catch { /* renamed */ } }
}
function locked<T>(dir: string, fn: () => T): T {
  privateDir(dir);
  const lock = path.join(dir, 'setup.lock');
  let fd: number;
  try { fd = fs.openSync(lock, 'wx', 0o600); } catch { throw new Error('Another setup is running or was interrupted. Close other setup sessions; preserve manifest.json and backups before removing a stale setup.lock.'); }
  try { return fn(); } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
export function validateSetupStorage(options: { root: string; home: string; stateDir: string }) {
  if (!path.isAbsolute(options.home) || path.resolve(options.home) === path.resolve(options.root) || path.resolve(options.home).startsWith(path.resolve(options.root) + path.sep)) throw new Error('Choose a private corpus outside the code checkout.');
  if ([options.root, options.home].some((p) => path.resolve(options.stateDir) === path.resolve(p) || path.resolve(options.stateDir).startsWith(path.resolve(p) + path.sep))) throw new Error('Keep private setup backups outside the code checkout and corpus.');
}
export function connect(selected: Connection[], options: { root: string; home: string; stateDir: string; projects: string[]; autowrite: boolean }): number {
  if (!selected.length) return 0;
  validateSetupStorage(options);
  if (!fs.existsSync(path.join(options.root, 'dist/cli/mcp-proxy.js'))) throw new Error('Build Cairn first: npm run cairn:build-cli');
  return locked(options.stateDir, () => {
    const manifest = readManifest(options.stateDir);
    const edits = new Map<string, { before: string; after: string }>();
    const added: SavedConnection[] = [];
    for (const c of selected) {
      if (c.state !== 'available' || manifest.connections.some((s) => s.id === c.id)) throw new Error('Selection changed or is already managed. Rescan before connecting.');
      assertWritableFile(c.file);
      const before = readText(c.file);
      if (hash(before) !== c.fingerprint) throw new Error('Configuration changed after discovery. Rescan before connecting.');
      if (unsupported(c.entry, c.client)) throw new Error('Connection is not supported.');
      if (needsOAuth(c.entry)) {
        const auth = readOAuth(oauthFile(options.stateDir, c.id), String(c.entry.url ?? c.entry.serverUrl));
        if (auth.needsLogin || !auth.checkedAt || auth.checkedAt > Date.now() || Date.now() - auth.checkedAt > 30 * 60_000) throw new Error('Finish the connection check and sign-in in guided setup before installing this connection.');
      }
      const revision = randomUUID(), installed = wrapper(c, options.root, options.home, revision, options.autowrite, options.stateDir);
      const current = edits.get(c.file) ?? { before, after: before };
      current.after = editEntry(current.after, c.format, c.keys, installed); edits.set(c.file, current);
      added.push({ client: c.client, file: c.file, scope: c.scope, keys: c.keys, format: c.format, id: c.id, name: c.name, original: c.entry, installed, revision, home: options.home, installedAt: new Date().toISOString() });
    }
    privateDir(options.home); fs.mkdirSync(path.join(options.home, 'cairn'), { recursive: true });
    const backups = path.join(options.stateDir, 'backups'); privateDir(backups);
    for (const [file, change] of edits) fs.writeFileSync(path.join(backups, `${hash(file).slice(0, 16)}-${randomUUID()}.cfg`), change.before, { flag: 'wx', mode: 0o600 });
    // Journal BEFORE changing client files. Interrupted installs remain undoable.
    const updated: Manifest = { version: 1, projects: [...new Set([...manifest.projects, ...options.projects])], connections: [...manifest.connections, ...added] };
    writePrivate(path.join(options.stateDir, 'manifest.json'), encode(updated) + '\n');
    for (const [file, change] of edits) replaceFile(file, change.before, change.after);
    return added.length;
  });
}
export function undo(stateDir: string): { restored: number; conflicts: string[] } {
  return locked(stateDir, () => {
    const manifest = readManifest(stateDir), remaining: SavedConnection[] = [], conflicts: string[] = [];
    let restored = 0;
    for (const c of manifest.connections) {
      try {
        const before = readText(c.file), current = atPath(parseConfig(before, c.format), c.keys);
        if (equal(current, c.original)) { restored++; continue; } // journal written, config not yet changed
        if (!equal(current, c.installed)) { remaining.push(c); conflicts.push(c.id); continue; }
        replaceFile(c.file, before, editEntry(before, c.format, c.keys, c.original)); restored++;
      } catch { remaining.push(c); conflicts.push(c.id); }
    }
    writePrivate(path.join(stateDir, 'manifest.json'), encode({ ...manifest, connections: remaining }) + '\n');
    return { restored, conflicts };
  });
}
