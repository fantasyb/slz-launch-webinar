/**
 * Enterprise controls for the HOSTED gateway — the three things a security
 * review and a SOC 2 / ISO audit ask for at the agent↔tool chokepoint:
 * authenticated access, role-based authorization, and a tamper-evident audit
 * trail. None of this affects the local single-user install (loopback, no
 * policy): it engages only when an org policy is present, so the same binary is
 * a frictionless personal tool and a governed enterprise gateway.
 *
 * AUTH. A connecting client presents a bearer token. The org policy stores only
 * the SHA-256 of each token (never the raw secret), keyed to a principal
 * (id + role), so a leaked policy file cannot be replayed as credentials. With
 * no policy, or auth not required, the principal is the local admin.
 *
 * AUTHZ (RBAC). A role names which servers it may reach and which tools it may
 * not, and may be read-only (write-looking tools denied via the same
 * classifier the gateway already uses). Deny wins.
 *
 * AUDIT. Every decision — a call allowed, a call denied, an auth failure — is
 * appended to a hash-chained JSONL log: each entry carries the hash of the one
 * before it, so any edit, deletion, or reordering of committed entries is
 * detectable by re-walking the chain. It is append-only and exportable (it IS
 * the SIEM feed). Anchoring the head off-box (signing, or shipping to append-
 * only remote storage) is the next hardening and is what makes it evidence
 * against an attacker with write access to the box; the chain alone catches
 * tampering and corruption.
 */
import fs from 'fs';
import path from 'path';
import { createHash, randomBytes } from 'crypto';
import { execFileSync } from 'child_process';
import { homePath } from './home';
import { readsAsWrite, type Annotations } from './toolsurface';

/* ---- policy ------------------------------------------------------------- */

export interface Principal {
  id: string;
  role: string;
  /** RFC3339. When set and in the past, the token is rejected as expired — a
   * credential lifecycle an audit will ask for. Absent means no expiry. */
  expiresAt?: string;
}

export interface Role {
  /** Servers this role may reach. Absent means all (subject to deny). */
  allowServers?: string[];
  denyServers?: string[];
  /** Exposed tool names this role may never call. */
  denyTools?: string[];
  /** Deny any write-looking tool (create/update/delete/deploy/…). */
  readOnly?: boolean;
}

export interface OrgPolicy {
  auth: { required: boolean };
  /** Keyed by sha256(token) hex — never the raw token. */
  principals: Record<string, Principal>;
  roles: Record<string, Role>;
}

/** The principal used when no org policy governs this gateway (local/personal). */
export const LOCAL_ADMIN: Principal = { id: 'local', role: 'admin' };

export function orgPolicyPath(): string | null {
  if (process.env.CAIRN_ORG_POLICY) return process.env.CAIRN_ORG_POLICY;
  try {
    return homePath('org-policy.json');
  } catch {
    return null;
  }
}

/**
 * The result of trying to load the policy, kept as three distinct states so a
 * caller can do the one thing that matters: NEVER treat a policy that exists but
 * cannot be read as "no policy". A corrupt, half-written, or permission-denied
 * policy must fail CLOSED (the gateway refuses), not fall back to the ungoverned
 * personal case — that would silently turn every control off while the file that
 * turns them on is sitting right there.
 *
 *   - `none`  — the file genuinely does not exist (ENOENT). The personal case.
 *   - `ok`    — a valid policy.
 *   - `error` — the file exists but is unreadable or invalid. Fail closed.
 */
export type PolicyLoad =
  | { status: 'none' }
  | { status: 'ok'; policy: OrgPolicy }
  | { status: 'error'; reason: string };

function isObj(v: unknown): v is Record<string, unknown> { return !!v && typeof v === 'object' && !Array.isArray(v); }

export function readOrgPolicy(): PolicyLoad {
  const p = orgPolicyPath();
  if (!p) return { status: 'none' };
  let text: string;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch (e) {
    // ENOENT is the only "no policy" — every other error (EACCES, EISDIR, a
    // read failure) is a policy that exists but cannot be read: fail closed.
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'none' };
    return { status: 'error', reason: `policy exists but cannot be read: ${(e as Error).message}` };
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { status: 'error', reason: 'policy is not valid JSON (a truncated or corrupt file)' }; }
  if (!isObj(raw)) return { status: 'error', reason: 'policy is not a JSON object' };
  // Strict: auth.required must be a real boolean. A missing key, a string
  // "true", or a typo does not get to mean "auth off" by coincidence.
  if (!isObj(raw.auth) || typeof raw.auth.required !== 'boolean') return { status: 'error', reason: 'policy.auth.required must be present and a boolean' };
  if (raw.principals !== undefined && !isObj(raw.principals)) return { status: 'error', reason: 'policy.principals must be an object' };
  if (raw.roles !== undefined && !isObj(raw.roles)) return { status: 'error', reason: 'policy.roles must be an object' };
  return {
    status: 'ok',
    policy: {
      auth: { required: raw.auth.required },
      principals: (raw.principals ?? {}) as Record<string, Principal>,
      roles: (raw.roles ?? {}) as Record<string, Role>,
    },
  };
}

/**
 * The lenient loader the CLIs use: a valid policy, or null for "no usable
 * policy" (absent OR invalid). The security-critical caller (the gateway) must
 * use `readOrgPolicy` instead, so it can fail closed on `error` rather than
 * conflating it with `none`.
 */
export function loadOrgPolicy(): OrgPolicy | null {
  const r = readOrgPolicy();
  return r.status === 'ok' ? r.policy : null;
}

export const tokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');

/** Bearer header ("Bearer <token>") to the raw token, or null. */
export function bearerToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return m ? m[1].trim() : null;
}

export interface AuthResult {
  principal: Principal | null;
  /** Present when authentication was refused. */
  reason?: string;
}

/**
 * Resolve the principal for a request. No policy, or auth not required, is the
 * local admin — the personal case. With auth required, a valid bearer token is
 * mandatory and maps to its principal; anything else is refused.
 */
export function authenticate(policy: OrgPolicy | null, authorization: string | undefined): AuthResult {
  if (!policy || !policy.auth.required) return { principal: LOCAL_ADMIN };
  const token = bearerToken(authorization);
  if (!token) return { principal: null, reason: 'no bearer token' };
  const principal = policy.principals[tokenHash(token)];
  if (!principal) return { principal: null, reason: 'unknown token' };
  if (principal.expiresAt) {
    const exp = Date.parse(principal.expiresAt);
    if (Number.isFinite(exp) && exp <= Date.now()) return { principal: null, reason: 'token expired' };
  }
  return { principal };
}

export interface AuthzResult {
  allowed: boolean;
  reason: string;
}

/**
 * May this principal call this tool on this server? Deny wins, and an unknown
 * role denies everything (fail closed). With no policy, all is allowed — the
 * personal case, where the gateway governs nothing.
 */
export function authorize(
  policy: OrgPolicy | null,
  principal: Principal,
  server: string,
  tool: { name: string; annotations?: Annotations | null; aliases?: string[] },
): AuthzResult {
  if (!policy) return { allowed: true, reason: 'no org policy' };
  // The local/personal principal is ungoverned by construction: it is the
  // identity used when no one authenticated (stdio, or loopback with auth off).
  // A policy file that happens to be present must not start denying a personal
  // install — governance engages only for a principal that authenticated
  // against the policy, never for this sentinel. Compared by identity, so an
  // org that defines its own "admin" ROLE is unaffected.
  if (principal === LOCAL_ADMIN) return { allowed: true, reason: 'local admin (ungoverned)' };
  // hasOwn, not index: a role named "__proto__"/"constructor"/"toString" would
  // otherwise resolve to an inherited object and authorize everything.
  const role = Object.prototype.hasOwnProperty.call(policy.roles, principal.role) ? policy.roles[principal.role] : undefined;
  if (!role || typeof role !== 'object') return { allowed: false, reason: `role "${principal.role}" is not defined in the org policy` };
  if (role.denyServers?.includes(server)) return { allowed: false, reason: `role "${principal.role}" is denied server "${server}"` };
  if (role.allowServers && !role.allowServers.includes(server)) return { allowed: false, reason: `role "${principal.role}" may only reach ${role.allowServers.join(', ')}` };
  // denyTools is matched against the exposed name AND the raw upstream name
  // (aliases), case-folded — an operator copies the name their client shows
  // (`github__delete_repo`), which is the exposed one, while the gateway routes
  // by the raw one; a mismatch there is a deny that silently does nothing.
  if (role.denyTools?.length) {
    const denied = new Set(role.denyTools.map((t) => t.toLowerCase()));
    const candidates = [tool.name, ...(tool.aliases ?? [])].map((n) => n.toLowerCase());
    const hit = candidates.find((c) => denied.has(c));
    if (hit) return { allowed: false, reason: `role "${principal.role}" is denied tool "${tool.name}"` };
  }
  if (role.readOnly) {
    const declaredWrite = tool.annotations?.readOnlyHint === false || tool.annotations?.destructiveHint === true;
    const namedWrite = readsAsWrite(tool.name);
    if (declaredWrite || namedWrite) return { allowed: false, reason: `role "${principal.role}" is read-only; "${tool.name}" reads as a write` };
  }
  return { allowed: true, reason: 'permitted by role' };
}

/* ---- audit -------------------------------------------------------------- */

export type AuditDecision = 'call' | 'allow' | 'deny' | 'auth-fail' | 'error';

export interface AuditEntry {
  seq: number;
  at: string;
  principal: string;
  decision: AuditDecision;
  server?: string;
  tool?: string;
  reason?: string;
  /** The gateway session this decision belongs to, so a SIEM can correlate a
   * run's activity and tie an auth-fail source to later calls. */
  session?: string;
  /** The client's self-reported name (clientInfo.name), for context. Untrusted. */
  agent?: string;
  prevHash: string;
  hash: string;
}

const GENESIS = '0'.repeat(64);
const auditFile = (dir: string) => path.join(dir, 'audit.jsonl');

/** Stable serialization of the signed fields, so the hash is reproducible.
 * session and agent are inside the hash, so tampering with correlation data is
 * caught like any other edit. Field order is the hash format's version — appended
 * to, never reordered. */
function chainHash(prevHash: string, e: Omit<AuditEntry, 'prevHash' | 'hash'>): string {
  const body = JSON.stringify([e.seq, e.at, e.principal, e.decision, e.server ?? '', e.tool ?? '', e.reason ?? '', e.session ?? '', e.agent ?? '']);
  return createHash('sha256').update(prevHash).update('\n').update(body).digest('hex');
}

/*
 * Cross-PROCESS serialization. One hosted process is the design, but blue/green
 * deploys, a pm2 cluster, or a stray CLI run mean two processes can share one
 * CAIRN_HOME. Without a lock they interleave appends off a stale in-process head
 * and the chain reads as tampered during NORMAL operation — which trains an
 * operator to ignore verify, the one thing that must stay trustworthy. So the
 * append (and the anchor write) runs under an OS-level exclusive lock file, and
 * derives the head from the file's true tail under that lock, not from a
 * per-process cache. Best-effort: audit must never block a tool call for long,
 * so after a bounded wait we proceed unlocked rather than drop the entry — a
 * rare interleave that verify would catch is better than a lost audit row.
 */
const lockPath = (dir: string) => path.join(dir, 'audit.lock');
const sleepMs = (ms: number) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no SAB: skip the wait */ } };

/** Is this pid a live process? EPERM means it exists but we can't signal it. */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/*
 * How stale a lock's mtime may be before a LIVE-pid holder is still considered
 * abandoned. A pid that is dead breaks immediately regardless; this bounds only
 * the "the process is alive but wedged" case. The default is generous (15s)
 * because every hold is short — appends are one write, and rotation is a rename
 * plus a small write. The one hold that can run long is the verifyAudit done
 * under the lock in anchorHead/rotateAudit when there are many archived
 * segments to re-walk; a synchronous hold cannot heartbeat its own mtime (no
 * async yield point to fire a timer), so rather than a fake heartbeat we let an
 * operator with a large corpus widen the window via CAIRN_AUDIT_LOCK_STALE_MS.
 */
const LOCK_STALE_MS = Math.max(2_000, Number(process.env.CAIRN_AUDIT_LOCK_STALE_MS) || 15_000);

/**
 * Break a lock only when its holder is provably gone: the pid written in it is
 * dead, OR its mtime is more than LOCK_STALE_MS off from now in EITHER direction
 * (a crashed holder, or a clock-skewed/future mtime that a one-sided check would
 * treat as fresh forever). The break is atomic — rename to a unique tombstone,
 * then unlink it — so exactly one racer wins and a live holder is never removed.
 */
function tryBreakStaleLock(lp: string): boolean {
  let content = '';
  let mtimeMs = Date.now();
  try { const st = fs.statSync(lp); mtimeMs = st.mtimeMs; content = fs.readFileSync(lp, 'utf8'); } catch { return false; }
  const pid = Number(content.split(':')[0]);
  const skew = Math.abs(Date.now() - mtimeMs);
  if (pidAlive(pid) && skew < LOCK_STALE_MS) return false; // a live, recent holder — leave it
  try {
    const tomb = `${lp}.${process.pid}.${Date.now()}.stale`;
    fs.renameSync(lp, tomb); // only one racer's rename of THIS inode succeeds
    fs.unlinkSync(tomb);
    return true;
  } catch { return false; } // someone else already broke/renamed it: just retry the loop
}

/**
 * Run `fn` holding an exclusive lock over the audit dir. Returns whether the
 * lock was actually acquired. On failure (a filesystem that cannot lock, or
 * sustained contention past the deadline) it returns `{ locked: false }` and
 * does NOT run `fn` — the caller SPILLS the row instead (see appendAudit), so a
 * seq/hash is never computed off an unlocked, racing head. That is the fix for
 * the collisions the old "just proceed unlocked" fallback produced: two writers
 * off one disk tail computed the same seq and broke the chain permanently.
 */
function withAuditLock<T>(dir: string, fn: () => T): { locked: boolean; value?: T } {
  const lp = lockPath(dir);
  const token = `${process.pid}:${randomBytes(6).toString('hex')}`;
  const deadline = Date.now() + 3000;
  for (;;) {
    try {
      const fd = fs.openSync(lp, 'wx'); // atomic exclusive create
      try { fs.writeSync(fd, token); } finally { fs.closeSync(fd); }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return { locked: false }; // cannot lock here at all
      if (tryBreakStaleLock(lp)) continue;
      if (Date.now() > deadline) return { locked: false }; // contended too long: spill, never append unlocked
      sleepMs(10);
    }
  }
  try { return { locked: true, value: fn() }; }
  finally { try { if (fs.readFileSync(lp, 'utf8') === token) fs.unlinkSync(lp); } catch { /* broken/replaced by a stale-breaker: leave it */ } }
}

/* A row that could not be written under the lock is SPILLED to a per-process
 * file (plain JSON, no seq, no chain) and folded into the chain — in order,
 * under the lock — by the next writer that does hold it. Nothing is lost, and no
 * seq is ever assigned without the lock. */
const spillPath = (dir: string) => path.join(dir, `audit.spill.${process.pid}.jsonl`);
type SpillRow = { at?: string; principal: string; decision: AuditDecision; server?: string; tool?: string; reason?: string; session?: string; agent?: string };
function spillRow(dir: string, e: SpillRow): void {
  try { fs.appendFileSync(spillPath(dir), JSON.stringify({ ...e, at: e.at ?? new Date().toISOString() }) + '\n'); }
  catch (err) { process.stderr.write(`cairn-proxy: could not spill audit entry: ${(err as Error).message}\n`); }
}
/** Fold every process's spilled rows into the chain. MUST run under the lock. */
function foldSpills(dir: string): void {
  let files: string[];
  try { files = fs.readdirSync(dir).filter((f) => f.startsWith('audit.spill.') && f.endsWith('.jsonl')); } catch { return; }
  for (const f of files.sort()) {
    const fp = path.join(dir, f);
    let rows: SpillRow[];
    try { rows = fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as SpillRow]; } catch { return []; } }); } catch { continue; }
    for (const r of rows) appendChained(dir, r);
    try { fs.unlinkSync(fp); } catch { /* another folder took it */ }
  }
}

/** The raw chained append. MUST run under the lock: it reads the true disk head
 * and writes exactly one entry. */
function appendChained(dir: string, e: SpillRow): void {
  const tail = diskHead(dir);
  const seq = tail.seq + 1;
  // Cap client-/upstream-controlled fields so one entry cannot be made huge (an
  // upstream error body in `reason`, a 100 KB clientInfo.name in `agent`), which
  // would bloat every row and, once a line outgrows the tail window, cost a
  // full-file read per append.
  const cap = (s: string | undefined, n: number) => (s !== undefined && s.length > n ? s.slice(0, n) + '…' : s);
  const partial = { seq, at: e.at ?? new Date().toISOString(), principal: cap(e.principal, 128)!, decision: e.decision, server: cap(e.server, 128), tool: cap(e.tool, 128), reason: cap(e.reason, 500), session: cap(e.session, 128), agent: cap(e.agent, 120) };
  const hash = chainHash(tail.hash, partial);
  const entry: AuditEntry = { ...partial, prevHash: tail.hash, hash };
  // A crash-truncated tail line has no trailing newline; start on a fresh line
  // so our valid entry is not fused onto the garbage.
  const lead = !tail.empty && !tail.endsWithNL ? '\n' : '';
  fs.appendFileSync(auditFile(dir), lead + JSON.stringify(entry) + '\n');
  writeHeadSidecar(dir, { seq, hash, at: entry.at });
  heads.set(dir, { seq, hash });
}

/** The chain head as it is ON DISK right now — the last parseable entry, read
 * from a bounded tail so an append does not cost a full-file read. Also reports
 * whether the file ends in a newline (so an append after a crash-truncated line
 * does not fuse onto it) and its size. No rotation "carry": the continuation
 * after a rotation is a real chained MARKER entry written into the new segment
 * (see rotateAudit), so an absent or empty live file is genesis — a truncation,
 * which verify catches — never a silently-continued forged chain. */
function diskHead(dir: string): { seq: number; hash: string; endsWithNL: boolean; empty: boolean } {
  try {
    const fd = fs.openSync(auditFile(dir), 'r');
    try {
      const size = fs.fstatSync(fd).size;
      if (size === 0) return { seq: 0, hash: GENESIS, endsWithNL: true, empty: true };
      const want = Math.min(65536, size);
      const buf = Buffer.alloc(want);
      fs.readSync(fd, buf, 0, want, size - want);
      const endsWithNL = buf[want - 1] === 0x0a;
      let lines = buf.toString('utf8').split('\n').filter(Boolean);
      const pick = (ls: string[]) => { for (let i = ls.length - 1; i >= 0; i--) { try { const e = JSON.parse(ls[i]) as AuditEntry; if (typeof e.seq === 'number' && typeof e.hash === 'string') return { seq: e.seq, hash: e.hash }; } catch { /* walk back */ } } return null; };
      let h = pick(lines);
      if (!h && want < size) { lines = fs.readFileSync(auditFile(dir), 'utf8').split('\n').filter(Boolean); h = pick(lines); } // very long lines: fall back to a full read
      return { seq: h?.seq ?? 0, hash: h?.hash ?? GENESIS, endsWithNL, empty: false };
    } finally { fs.closeSync(fd); }
  } catch {
    return { seq: 0, hash: GENESIS, endsWithNL: true, empty: true };
  }
}

/* A per-process head cache, advisory only now that the disk tail under the lock
 * is the source of truth. Kept so head-reading callers and tests have something
 * to reset. */
const heads = new Map<string, { seq: number; hash: string }>();

const headSidecar = (dir: string) => path.join(dir, 'head.json');
/** The last head we committed, written beside the log so a RESTART can tell that
 * the file was truncated after we last wrote (the tail-deletion the in-file chain
 * alone cannot see: dropping the last k lines still verifies clean). Atomic. */
function writeHeadSidecar(dir: string, h: { seq: number; hash: string; at: string }): void {
  try {
    const tmp = path.join(dir, `.head.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(h));
    fs.renameSync(tmp, headSidecar(dir));
  } catch { /* best-effort: the sidecar is a cross-check, not the record */ }
}
function readHeadSidecar(dir: string): { seq: number; hash: string; at: string } | null {
  try { return JSON.parse(fs.readFileSync(headSidecar(dir), 'utf8')) as { seq: number; hash: string; at: string }; } catch { return null; }
}

/** Append one tamper-evident audit entry. Best-effort: a log that cannot be
 * written must never break a tool call, but the failure is loud on stderr. */
export function appendAudit(dir: string, e: { at?: string; principal: string; decision: AuditDecision; server?: string; tool?: string; reason?: string; session?: string; agent?: string }): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const r = withAuditLock(dir, () => {
      foldSpills(dir);        // bring any spilled rows into the chain first, in order
      appendChained(dir, e);  // then our own, off the true disk head
    });
    if (!r.locked) spillRow(dir, e); // could not lock: keep the row, fold it later — never append unlocked
  } catch (err) {
    process.stderr.write(`cairn-proxy: could not write audit entry: ${(err as Error).message}\n`);
  }
}

/* ---- off-box anchoring -------------------------------------------------- */
/*
 * The in-file hash chain catches an editor; it CANNOT catch an attacker with
 * write access to the whole file, who can recompute every hash after a change
 * (a limit the module discloses). An ANCHOR is the defense: a checkpoint of the
 * chain head — (seq, hash) — published somewhere the attacker does not control.
 * Anchors are themselves chained, appended to anchors.jsonl, and shipped off-box
 * by an operator-supplied command (CAIRN_AUDIT_ANCHOR_CMD; the anchor JSON on
 * stdin — pipe it to git, a WORM bucket, a webhook). verifyAudit then confirms
 * the live chain still matches every anchor: a rewrite or truncation below an
 * anchored seq is caught even when the whole file was re-hashed, because the
 * attacker cannot change an anchor already shipped off the box.
 */
export interface Anchor {
  seq: number;
  hash: string;
  at: string;
  prevAnchorHash: string;
  anchorHash: string;
}
const anchorFile = (dir: string) => path.join(dir, 'anchors.jsonl');
function anchorChainHash(prevAnchorHash: string, a: { seq: number; hash: string; at: string }): string {
  return createHash('sha256').update(prevAnchorHash).update('\n').update(JSON.stringify([a.seq, a.hash, a.at])).digest('hex');
}

export function readAnchors(dir: string): Anchor[] {
  try {
    return fs.readFileSync(anchorFile(dir), 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as Anchor]; } catch { return []; } });
  } catch { return []; }
}

/**
 * Load an OFF-BOX copy of an anchor file, verify its own chain integrity, and
 * return its (seq, hash) checkpoints for `verifyAudit(..., { against })`. This is
 * how an operator checks the live log against the full anchor chain they saved
 * elsewhere — stronger than a single `--against seq:hash`, because it also
 * confirms the off-box chain itself was not tampered and catches truncation at
 * any anchored seq.
 */
export function loadAnchorFile(file: string): { ok: boolean; pairs: { seq: number; hash: string }[]; detail?: string } {
  let anchors: Anchor[];
  try { anchors = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Anchor); }
  catch (e) { return { ok: false, pairs: [], detail: `cannot read anchor file: ${(e as Error).message}` }; }
  let prev = GENESIS;
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    if (a.prevAnchorHash !== prev || anchorChainHash(prev, { seq: a.seq, hash: a.hash, at: a.at }) !== a.anchorHash) {
      return { ok: false, pairs: [], detail: `the anchor file's own chain is broken at anchor #${i + 1} — the off-box copy was tampered with` };
    }
    prev = a.anchorHash;
  }
  return { ok: true, pairs: anchors.map((a) => ({ seq: a.seq, hash: a.hash })) };
}

const shippedCursor = (dir: string) => path.join(dir, 'anchors.shipped');
const shipAlarm = (dir: string) => path.join(dir, 'anchors.ship-alarm');

function shipOne(a: Anchor, cmd: string): boolean {
  try {
    // killSignal SIGKILL so the timeout is REAL — a ship command that ignores
    // SIGTERM cannot hold us past the bound (SIGTERM alone is only requested).
    execFileSync('/bin/sh', ['-c', cmd], { input: JSON.stringify(a) + '\n', timeout: 10_000, killSignal: 'SIGKILL', stdio: ['pipe', 'ignore', 'ignore'] });
    return true;
  } catch (err) {
    process.stderr.write(`cairn: audit anchor ship failed (kept locally, will retry): ${(err as Error).message}\n`);
    return false;
  }
}

/**
 * Ship every anchor past the shipped cursor, in order, OUTSIDE the lock. A
 * transient outage no longer leaves a permanent hole: the cursor advances only
 * on success, so the next call re-ships from where it stopped. A sustained
 * failure drops a marker the daemon/CLI can surface. Runs the ship command,
 * which may be slow — which is exactly why it must not hold the audit lock
 * (that would stall every gateway append behind it).
 */
export function shipAnchors(dir: string): void {
  const cmd = process.env.CAIRN_AUDIT_ANCHOR_CMD;
  if (!cmd) return;
  const anchors = readAnchors(dir);
  if (!anchors.length) return;
  let cursor = '';
  try { cursor = fs.readFileSync(shippedCursor(dir), 'utf8').trim(); } catch { /* nothing shipped yet */ }
  const at = cursor ? anchors.findIndex((a) => a.anchorHash === cursor) : -1;
  const pending = anchors.slice(at + 1);
  for (const a of pending) {
    if (!shipOne(a, cmd)) {
      try { fs.writeFileSync(shipAlarm(dir), JSON.stringify({ at: new Date().toISOString(), unshipped: pending.length, sinceSeq: a.seq }) + '\n'); } catch { /* best-effort */ }
      return; // stop at the first failure; keep order; retry next call
    }
    try { fs.writeFileSync(shippedCursor(dir), a.anchorHash); } catch { /* cursor is an optimization; a re-ship is harmless */ }
  }
  try { if (fs.existsSync(shipAlarm(dir))) fs.unlinkSync(shipAlarm(dir)); } catch { /* best-effort */ }
}

/**
 * Has this anchor been shipped off-box? True when the shipped cursor names this
 * anchor or a LATER one (a concurrent anchor may have shipped after it). Used to
 * gate rotation: archiving a segment is only safe once the boundary that pins it
 * is off-box, because a deleted archive is then detectable only via that anchor.
 */
function anchorShipped(dir: string, anchor: Anchor): boolean {
  let cursor = '';
  try { cursor = fs.readFileSync(shippedCursor(dir), 'utf8').trim(); } catch { return false; }
  if (!cursor) return false;
  if (cursor === anchor.anchorHash) return true;
  const anchors = readAnchors(dir);
  const ci = anchors.findIndex((a) => a.anchorHash === cursor);
  const ai = anchors.findIndex((a) => a.anchorHash === anchor.anchorHash);
  return ci !== -1 && ai !== -1 && ci >= ai;
}

/**
 * Checkpoint the current chain head as an anchor. Refuses to anchor a log that
 * does not verify (never certify a broken chain), folds spilled rows first, and
 * writes the anchor under the lock — then ships OUTSIDE the lock. Returns the
 * anchor, or null when there is nothing to anchor, the head is already anchored,
 * or the log is broken.
 */
export function anchorHead(dir: string): Anchor | null {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const r = withAuditLock(dir, (): Anchor | { skip: string } | null => {
      foldSpills(dir);
      // Never anchor a broken log: an anchor of a forgery launders it into the
      // trust root. Verify under the lock so no append moves the head first.
      const v = verifyAudit(dir);
      if (!v.ok) return { skip: `refusing to anchor a broken log: ${v.detail}` };
      const tail = diskHead(dir);
      if (tail.empty || tail.seq === 0) return null;
      const existing = readAnchors(dir);
      // Defense in depth against laundering: if we have EVER shipped an anchor (a
      // ship cursor exists) but the anchor log is now gone, someone deleted it —
      // refuse to start a fresh genesis-rooted chain over a possibly-rewritten
      // log, which would re-anchor and ship a forgery as the new trust root.
      if (!existing.length) {
        try { if (fs.existsSync(shippedCursor(dir))) return { skip: 'anchors.jsonl is gone but a ship cursor exists — refusing to re-anchor (possible tampering)' }; } catch { /* ignore */ }
      }
      const last = existing.length ? existing[existing.length - 1] : null;
      const prevAnchorHash = last ? last.anchorHash : GENESIS;
      if (last && last.seq === tail.seq && last.hash === tail.hash) return last; // head unchanged since last anchor
      const at = new Date().toISOString();
      const anchor: Anchor = { seq: tail.seq, hash: tail.hash, at, prevAnchorHash, anchorHash: anchorChainHash(prevAnchorHash, { seq: tail.seq, hash: tail.hash, at }) };
      let lead = '';
      try { const b = fs.readFileSync(anchorFile(dir)); if (b.length && b[b.length - 1] !== 0x0a) lead = '\n'; } catch { /* no file yet */ }
      fs.appendFileSync(anchorFile(dir), lead + JSON.stringify(anchor) + '\n');
      return anchor;
    });
    if (!r.locked || r.value == null) return null; // contended, or nothing to anchor
    const out = r.value;
    if ('skip' in out) { process.stderr.write(`cairn: ${out.skip}\n`); return null; }
    shipAnchors(dir); // outside the lock: a slow ship never blocks appends
    return out;
  } catch (err) {
    process.stderr.write(`cairn: could not write audit anchor: ${(err as Error).message}\n`);
    return null;
  }
}

export interface AuditVerdict {
  ok: boolean;
  entries: number;
  /** The 1-based line where the chain first breaks, if any. */
  brokenAt?: number;
  detail?: string;
}

export interface RotateResult {
  ok: boolean;
  archived?: string;
  fromSeq?: number;
  toSeq?: number;
  detail?: string;
}

/**
 * Rotate the live audit segment: archive audit.jsonl to a self-describing file,
 * and carry the head so the new segment CONTINUES the chain (seq monotonic,
 * prevHash linked) rather than restarting at genesis — which keeps every existing
 * anchor valid and lets verify follow the boundary. Refuses to rotate a log that
 * does not verify (never archive a broken chain), and takes a final anchor of the
 * head first so the boundary itself is checkpointed off-box. Bounds the live file
 * so appends and the tail read stay cheap however long the gateway runs.
 */
export interface Segment { file: string; firstSeq: number; lastSeq: number; firstPrevHash: string; lastHash: string; }
const segmentsFile = (dir: string) => path.join(dir, 'audit.segments.jsonl');
export function readSegments(dir: string): Segment[] {
  try { return fs.readFileSync(segmentsFile(dir), 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as Segment]; } catch { return []; } }); } catch { return []; }
}

export function rotateAudit(dir: string): RotateResult {
  // Anchor the current head BEFORE the rotation lock (anchorHead takes its own
  // lock; it also refuses a broken log, so this doubles as the pre-check). The
  // boundary must be pinned off-box, so refuse to rotate if the ship failed.
  const finalAnchor = anchorHead(dir);
  // When off-box anchoring is configured, the boundary anchor MUST be shipped
  // off-box before we archive: once the live segment becomes an archive file, a
  // deleted archive is detectable only via an off-box anchor pinning its
  // boundary (a local anchor cannot bridge it — the adversary has box write). So
  // if the ship did not land, refuse to rotate rather than silently trade away
  // that detectability; the operator fixes CAIRN_AUDIT_ANCHOR_CMD and retries.
  if (process.env.CAIRN_AUDIT_ANCHOR_CMD) {
    if (!finalAnchor) return { ok: false, detail: 'refusing to rotate: could not anchor the head off-box first (the log is broken or empty)' };
    if (!anchorShipped(dir, finalAnchor)) return { ok: false, detail: `refusing to rotate: the boundary anchor (seq ${finalAnchor.seq}) did not ship off-box — CAIRN_AUDIT_ANCHOR_CMD failed. Fix it and retry; without it a later deletion of this archive could not be detected.` };
  }
  const r = withAuditLock(dir, (): RotateResult => {
    foldSpills(dir);
    const v = verifyAudit(dir);
    if (!v.ok) return { ok: false, detail: `refusing to rotate a broken log: ${v.detail}` };
    let lines: string[];
    try { lines = fs.readFileSync(auditFile(dir), 'utf8').split('\n').filter(Boolean); } catch { return { ok: false, detail: 'no live segment to rotate' }; }
    if (!lines.length) return { ok: false, detail: 'the live segment is empty — nothing to rotate' };
    let first: AuditEntry | null = null;
    for (const l of lines) { try { first = JSON.parse(l) as AuditEntry; break; } catch { /* skip a corrupt leading line */ } }
    const tail = diskHead(dir);
    if (!first || tail.seq === 0) return { ok: false, detail: 'could not read the segment boundary' };
    const archiveName = `audit.${first.seq}-${tail.seq}.jsonl`;
    // Archive the live file, then record the segment, then START the new live
    // segment with a real CHAINED marker entry (seq = tail.seq+1, prevHash =
    // tail.hash). No unauthenticated "carry" file: an absent/empty live file is a
    // deletion, and the new segment's first entry chains from the archived head,
    // so a forged boundary cannot make verify skip anything.
    fs.renameSync(auditFile(dir), path.join(dir, archiveName));
    try { fs.appendFileSync(segmentsFile(dir), JSON.stringify({ file: archiveName, firstSeq: first.seq, lastSeq: tail.seq, firstPrevHash: first.prevHash, lastHash: tail.hash } as Segment) + '\n'); } catch { /* re-derivable from the archive itself */ }
    const at = new Date().toISOString();
    const marker = { seq: tail.seq + 1, at, principal: 'system', decision: 'allow' as AuditDecision, reason: `rotated: archived seq ${first.seq}-${tail.seq} to ${archiveName}` };
    const markerHash = chainHash(tail.hash, marker);
    fs.writeFileSync(auditFile(dir), JSON.stringify({ ...marker, prevHash: tail.hash, hash: markerHash }) + '\n');
    writeHeadSidecar(dir, { seq: marker.seq, hash: markerHash, at });
    heads.set(dir, { seq: marker.seq, hash: markerHash });
    return { ok: true, archived: archiveName, fromSeq: first.seq, toSeq: tail.seq };
  });
  if (!r.locked) return { ok: false, detail: 'could not take the audit lock to rotate' };
  const out = r.value!;
  if (out.ok && finalAnchor) shipAnchors(dir); // make sure the boundary anchor is shipped off-box
  return out;
}

/** Re-walk the chain and confirm every hash. Detects any edit, deletion, or
 * reordering of committed entries — and, via the head sidecar and the anchors,
 * a whole-file rewrite or a tail truncation that the in-file chain alone cannot
 * see. Pass `against` to require the live chain to still match anchors an
 * operator is holding OFF the box (the real defense against a box-level
 * attacker): each is `{ seq, hash }` from a `cairn:audit-log anchor` they saved
 * elsewhere. */
export function verifyAudit(dir: string, opts: { against?: { seq: number; hash: string }[] } = {}): AuditVerdict {
  // Read the cross-checks (anchors + head sidecar) BEFORE the log. Both are
  // written strictly AFTER the log line they describe, so a log read taken
  // afterwards is always at least as advanced — which means a concurrent append
  // can never make a clean log look "truncated" (the false-alarm race). Reading
  // the log first had the opposite order and fired spurious truncation alarms.
  const anchors = readAnchors(dir);
  const sc = readHeadSidecar(dir);

  // What the chain must match at a given seq. Conflicting expectations at one seq
  // are the STRONGEST tamper signal the design has (a real and a forged anchor,
  // or a rewritten sidecar) — never resolve them "last wins"; fail.
  const expectAtSeq = new Map<number, string>();
  let conflict: string | undefined;
  const expect = (seq: number, hash: string, source: string): void => {
    const cur = expectAtSeq.get(seq);
    if (cur !== undefined && cur !== hash) { conflict = conflict ?? `two checkpoints disagree at seq ${seq} (${source} vs an earlier one) — one is forged`; return; }
    expectAtSeq.set(seq, hash);
  };

  // Local anchor chain: verify its own integrity first, then adopt each expectation.
  let prevA = GENESIS;
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    if (a.prevAnchorHash !== prevA || anchorChainHash(prevA, { seq: a.seq, hash: a.hash, at: a.at }) !== a.anchorHash) {
      return { ok: false, entries: 0, detail: `the anchor log is inconsistent at anchor #${i + 1} — anchors were tampered with` };
    }
    expect(a.seq, a.hash, 'local anchor');
    prevA = a.anchorHash;
  }
  // External (off-box) anchors are tracked separately: only THEY may bridge a
  // missing archive, because a local anchor is on-box and the adversary here has
  // box write access. A missing archive with no off-box anchor pinning it is
  // unverifiable — never silently skipped.
  const externalAt = new Map<number, string>();
  for (const ext of opts.against ?? []) { expect(ext.seq, ext.hash, 'external anchor'); externalAt.set(ext.seq, ext.hash); }
  if (sc && typeof sc.seq === 'number' && typeof sc.hash === 'string') expect(sc.seq, sc.hash, 'head sidecar');
  if (conflict) return { ok: false, entries: 0, detail: conflict };

  // Walk the WHOLE chain — every archived segment (per the manifest), then the
  // live segment — as one continuous hash chain from genesis, checking every
  // checkpoint against the entry at its seq. Nothing is ever skipped: a forged
  // boundary cannot make an off-box anchor go unchecked, because there is no
  // boundary to trust — the live segment's first entry chains from the archived
  // head via a real marker entry, and each archive must chain from the previous.
  const matched = new Set<number>();
  const st = { prev: GENESIS, expectedSeq: 1, lastSeq: 0 };
  const walk = (lines: string[], where: string): AuditVerdict | null => {
    for (let i = 0; i < lines.length; i++) {
      let e: AuditEntry;
      try { e = JSON.parse(lines[i]) as AuditEntry; } catch { return { ok: false, entries: st.lastSeq, brokenAt: i + 1, detail: `${where}: line is not JSON` }; }
      if (e.prevHash !== st.prev) return { ok: false, entries: st.lastSeq, brokenAt: i + 1, detail: `${where}: prevHash does not match the previous entry (deletion or reorder)` };
      if (e.seq !== st.expectedSeq) return { ok: false, entries: st.lastSeq, brokenAt: i + 1, detail: `${where}: seq ${e.seq} out of order (expected ${st.expectedSeq})` };
      const recomputed = chainHash(st.prev, { seq: e.seq, at: e.at, principal: e.principal, decision: e.decision, server: e.server, tool: e.tool, reason: e.reason, session: e.session, agent: e.agent });
      if (recomputed !== e.hash) return { ok: false, entries: st.lastSeq, brokenAt: i + 1, detail: `${where}: hash does not match contents (entry was edited)` };
      const anchored = expectAtSeq.get(e.seq);
      if (anchored !== undefined) {
        if (anchored !== e.hash) return { ok: false, entries: st.lastSeq, brokenAt: i + 1, detail: `entry at seq ${e.seq} does not match a published checkpoint — the log was rewritten` };
        matched.add(e.seq);
      }
      st.prev = e.hash; st.lastSeq = e.seq; st.expectedSeq += 1;
    }
    return null;
  };

  for (const seg of readSegments(dir)) {
    let alines: string[] | null = null;
    try { alines = fs.readFileSync(path.join(dir, seg.file), 'utf8').split('\n').filter(Boolean); } catch { alines = null; }
    if (alines) {
      const r = walk(alines, `archive ${seg.file}`);
      if (r) return r;
      if (st.lastSeq !== seg.lastSeq || st.prev !== seg.lastHash) return { ok: false, entries: st.lastSeq, detail: `archive ${seg.file} does not match its manifest record` };
    } else {
      // The archive was moved OFF-box. Bridge it ONLY when an OFF-BOX (external)
      // anchor pins its boundary AND it links to the prior segment — never with a
      // local anchor (on-box, and this adversary can write the box). Without that
      // off-box anchor, archived history cannot be verified: fail.
      const boundary = externalAt.get(seg.lastSeq);
      if (boundary === undefined || boundary !== seg.lastHash) return { ok: false, entries: st.lastSeq, detail: `archive ${seg.file} (seq ${seg.firstSeq}-${seg.lastSeq}) is not present and no off-box anchor pins its boundary — its history cannot be verified` };
      if (st.expectedSeq !== seg.firstSeq || st.prev !== seg.firstPrevHash) return { ok: false, entries: st.lastSeq, detail: `archive ${seg.file} does not link to the previous segment` };
      matched.add(seg.lastSeq);
      st.prev = seg.lastHash; st.expectedSeq = seg.lastSeq + 1; st.lastSeq = seg.lastSeq;
    }
  }

  let live: string[];
  try { live = fs.readFileSync(auditFile(dir), 'utf8').split('\n').filter(Boolean); } catch { live = []; }
  const liveResult = walk(live, 'live segment');
  if (liveResult) return liveResult;

  // Any checkpoint not seen in the chain: beyond the end is a truncation; a gap
  // inside is a deletion. Either way the log lost entries a checkpoint pins.
  for (const [seq] of expectAtSeq) {
    if (!matched.has(seq)) return { ok: false, entries: st.lastSeq, detail: `a published checkpoint exists for seq ${seq} but the chain ends at ${st.lastSeq} — entries were truncated or deleted` };
  }

  if (st.lastSeq === 0) return { ok: true, entries: 0, detail: 'no audit log yet' };
  return { ok: true, entries: st.lastSeq };
}

export function readAudit(dir: string, limit?: number): AuditEntry[] {
  let lines: string[];
  try {
    lines = fs.readFileSync(auditFile(dir), 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
  const chosen = limit && limit > 0 ? lines.slice(-limit) : lines;
  // Skip an unparseable line (a crash-truncated tail) rather than discarding the
  // whole log — one corrupt line must not blind the reader to every real entry.
  // verifyAudit is the tamper check; this is the reader.
  const out: AuditEntry[] = [];
  for (const l of chosen) {
    try { out.push(JSON.parse(l) as AuditEntry); } catch { /* skip a corrupt line */ }
  }
  return out;
}

/** Reset the in-process head cache — tests build many logs in one process. */
export function _resetAuditCache(): void {
  heads.clear();
}
