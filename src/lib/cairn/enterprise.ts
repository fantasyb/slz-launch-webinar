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
import { createHash, createHmac, randomBytes } from 'crypto';
import { execFileSync } from 'child_process';
import { homePath } from './home';
import { readsAsWrite, foldName, type Annotations } from './toolsurface';

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
  /** Deny any write-looking tool (create/update/delete/deploy/…) by name/annotation. */
  readOnly?: boolean;
  /**
   * Fail-closed read-only: deny ANY tool not explicitly declared readOnlyHint:true.
   * The name heuristic (readOnly) is best-effort and a hostile server controls its
   * own tool names; strict mode does not trust the name at all, so an unannotated
   * or write-declared tool is denied. Use this where the read-only boundary is a
   * real control rather than a convenience.
   */
  readOnlyStrict?: boolean;
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
  // Validate the SHAPE of each principal and role, fail CLOSED on a typo (red-team
  // #6). A string `allowServers:"github"` (not an array) turns `.includes(server)`
  // into a substring test that admits `git`/`hub`/``; a principal missing `id`
  // maps its ledger rows to the operator's shard. Reject rather than misbehave.
  for (const [h, pr] of Object.entries((raw.principals ?? {}) as Record<string, unknown>)) {
    if (!isObj(pr) || typeof pr.id !== 'string' || !pr.id || typeof pr.role !== 'string' || !pr.role) {
      return { status: 'error', reason: `policy.principals["${h}"] must have a non-empty string id and role` };
    }
  }
  const strArr = (v: unknown) => v === undefined || (Array.isArray(v) && v.every((x) => typeof x === 'string'));
  for (const [name, role] of Object.entries((raw.roles ?? {}) as Record<string, unknown>)) {
    if (!isObj(role)) return { status: 'error', reason: `policy.roles["${name}"] must be an object` };
    if (!strArr(role.allowServers) || !strArr(role.denyServers) || !strArr(role.denyTools)) {
      return { status: 'error', reason: `policy.roles["${name}"] allowServers/denyServers/denyTools must each be an array of strings` };
    }
    for (const flag of ['readOnly', 'readOnlyStrict'] as const) {
      if (role[flag] !== undefined && typeof role[flag] !== 'boolean') return { status: 'error', reason: `policy.roles["${name}"].${flag} must be a boolean` };
    }
  }
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
    // A typo'd or unparseable expiry is REJECTED, not treated as "never expires":
    // Number.isFinite(NaN) is false, so the old guard let a bad date (2026-13-45)
    // yield a perpetual token — fail closed on a credential the operator meant to
    // bound.
    if (!Number.isFinite(exp)) return { principal: null, reason: 'token has an unparseable expiresAt' };
    if (exp <= Date.now()) return { principal: null, reason: 'token expired' };
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
    // Folded, not just lower-cased: a hostile server naming its tool `dеlete_repo`
    // (Cyrillic е) or spacing it out must not slip past an operator's denylist.
    const fold = (n: string) => foldName(n).toLowerCase();
    const denied = new Set(role.denyTools.map(fold));
    const candidates = [tool.name, ...(tool.aliases ?? [])].map(fold);
    const hit = candidates.find((c) => denied.has(c));
    if (hit) return { allowed: false, reason: `role "${principal.role}" is denied tool "${tool.name}"` };
  }
  if (role.readOnlyStrict) {
    // Do not trust the name at all: allow ONLY a tool the server itself declares
    // read-only. An unannotated or write-declared tool is denied.
    if (tool.annotations?.readOnlyHint !== true) {
      return { allowed: false, reason: `role "${principal.role}" is strict read-only; "${tool.name}" is not declared readOnlyHint:true` };
    }
  } else if (role.readOnly) {
    const declaredWrite = tool.annotations?.readOnlyHint === false || tool.annotations?.destructiveHint === true;
    // Classify the tool's OWN name, never the server's. The exposed name is
    // `${server}__${raw}`, so classifying it whole makes the server name the
    // leading token: a server called `zapier` (zap), `dropbox` (drop), `postgres`
    // (post), `sendgrid` (send), `runpod` (run) or `pushover` (push) turned EVERY
    // one of its tools into a write for a read-only role, and a server named with
    // a read verb (`search`) masked a raw write whose verb only prefix-matches
    // (red-team #7). Strip a leading `${server}__` from the exposed name and
    // classify that plus the raw aliases; the fail-closed direction is kept — a
    // genuine write verb in the tool's own name still denies.
    const prefix = `${server}__`;
    const ownName = tool.name.startsWith(prefix) ? tool.name.slice(prefix.length) : tool.name;
    const namedWrite = [ownName, ...(tool.aliases ?? [])].some((n) => readsAsWrite(n));
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

/**
 * Liveness of the pid written in a lock. 'alive' (signalable, or EPERM = exists
 * but no permission), 'dead' (invalid pid), or 'unknown'. ESRCH is UNKNOWN, not
 * dead: two containers sharing a CAIRN_HOME volume are in different pid
 * namespaces, so a holder alive in ITS namespace throws ESRCH here — treating
 * that as dead would break a live holder's lock immediately and interleave the
 * appends. An unknown pid may only be broken on mtime staleness, never eagerly.
 */
function pidLiveness(pid: number): 'alive' | 'dead' | 'unknown' {
  if (!Number.isInteger(pid) || pid <= 0) return 'dead';
  try { process.kill(pid, 0); return 'alive'; } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM' ? 'alive' : 'unknown';
  }
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
 * Break a lock only when its holder is provably gone. An ALIVE pid is never
 * broken. A DEAD pid (invalid) or a stale/skewed mtime (>LOCK_STALE_MS in either
 * direction) breaks. An UNKNOWN pid (ESRCH — possibly a live holder in another
 * pid namespace on a shared volume) is broken ONLY on mtime staleness, never
 * eagerly — a live cross-namespace holder keeps its mtime fresh. The break is
 * atomic (rename to a unique tombstone, then unlink) so exactly one racer wins.
 */
function tryBreakStaleLock(lp: string): boolean {
  let content = '';
  let mtimeMs = Date.now();
  try { const st = fs.statSync(lp); mtimeMs = st.mtimeMs; content = fs.readFileSync(lp, 'utf8'); } catch { return false; }
  const pid = Number(content.split(':')[0]);
  const skew = Math.abs(Date.now() - mtimeMs);
  const live = pidLiveness(pid);
  if (live === 'alive') return false;              // a live holder — never break
  if (live === 'unknown' && skew < LOCK_STALE_MS) return false; // maybe live elsewhere, mtime fresh — leave it
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
function withAuditLock<T>(dir: string, fn: () => T, maxWaitMs = 3000): { locked: boolean; value?: T } {
  const lp = lockPath(dir);
  const token = `${process.pid}:${randomBytes(6).toString('hex')}`;
  const deadline = Date.now() + maxWaitMs;
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
/*
 * Spill rows are AUTHENTICATED with a per-process key held only in memory.
 * Without this, a spill file is unauthenticated input that the next legitimate
 * writer chains into the log with a fresh seq/hash — the one write-to-dir path
 * that produces UNDETECTABLE forged audit entries (a fake allow, a fake deny to
 * frame a principal). Because the key never touches disk, an attacker with
 * file-write access cannot forge a row this process will fold, and a process
 * only ever folds ITS OWN spills (which it signed). A crashed process's spills
 * die with its key — unfoldable, so dropped rather than laundered.
 */
const SPILL_KEY = randomBytes(32);
/*
 * A per-row MAC is not enough on its own. The spill file is writable by any
 * process with this UID, and a same-box squatter can force EVERY append to spill
 * by planting an always-alive pid (`1:x`) in audit.lock — tryBreakStaleLock never
 * breaks a live pid. It can then delete, reorder or duplicate spill lines, each
 * still carrying a valid MAC, or unlink the file, and the fold would chain
 * whatever survived with fresh seqs: audit rows vanishing with no signal. So
 * each row carries a per-process MONOTONIC counter INSIDE the MAC, and the fold
 * requires exactly lastFolded+1..lastWritten, in order — a gap, a duplicate, a
 * reorder, or a vanished file is a discontinuity, folded as far as the rows are
 * authentic and ALARMED (stderr, and a chained `error` row so the gap is in the
 * log itself). The high-water marks live in memory beside the key, per audit
 * dir, so the attacker cannot move them.
 */
const spillCounters = new Map<string, { written: number; folded: number }>();
const spillState = (dir: string) => { let s = spillCounters.get(dir); if (!s) { s = { written: 0, folded: 0 }; spillCounters.set(dir, s); } return s; };
const spillHmac = (n: number, row: string): string => createHmac('sha256', SPILL_KEY).update(String(n)).update('\n').update(row).digest('hex');
function spillRow(dir: string, e: SpillRow): void {
  const st = spillState(dir);
  try {
    const row = JSON.stringify({ ...e, at: e.at ?? new Date().toISOString() });
    const n = st.written + 1;
    fs.appendFileSync(spillPath(dir), JSON.stringify({ n, row, hmac: spillHmac(n, row) }) + '\n');
    // Advanced only once the line is on disk: a failed write leaves no phantom
    // counter for the fold to alarm on (the torn line it may leave is dropped as
    // corrupt, and the counter is reused).
    st.written = n;
  } catch (err) { process.stderr.write(`cairn-proxy: could not spill audit entry: ${(err as Error).message}\n`); }
}
/** A spill discontinuity is never swallowed: loud on stderr AND written into
 * the chain as a system `error` row, so a SIEM reading the log sees the gap
 * where it happened. MUST run under the lock (it appends). */
function spillAlarm(dir: string, detail: string): void {
  process.stderr.write(`cairn-proxy: AUDIT ALARM — ${detail}\n`);
  try { appendChained(dir, { principal: 'system', decision: 'error', reason: `audit spill discontinuity: ${detail}` }); } catch { /* the stderr line is the primary signal */ }
}
/** Fold THIS process's own spilled rows into the chain, verifying each against
 * the in-memory key AND the counter sequence. MUST run under the lock. Orphaned
 * spill files from other (dead) processes are garbage-collected but never folded
 * — they cannot be authenticated, so folding them would launder unauthenticated
 * input. */
function foldSpills(dir: string): void {
  const own = spillPath(dir);
  const st = spillState(dir);
  // The counters this process has spilled and not yet folded: exactly what the
  // file must contain, in this order, and nothing else authentic.
  const want: number[] = [];
  for (let n = st.folded + 1; n <= st.written; n++) want.push(n);
  let text: string | null = null;
  try { text = fs.readFileSync(own, 'utf8'); } catch { text = null; }
  if (text === null) {
    // No file. Fine when nothing is outstanding; a vanished file with rows
    // outstanding is the squatter's unlink — alarm, and move the mark past them
    // so the alarm fires once rather than on every fold forever.
    if (want.length) spillAlarm(dir, `own spill file audit.spill.${process.pid}.jsonl is gone with ${want.length} row(s) unfolded (counters ${want[0]}-${want[want.length - 1]}) — deleted by another process`);
    st.folded = st.written;
  } else {
    const authentic: { n: number; row: SpillRow }[] = [];
    let dropped = 0;
    for (const l of text.split('\n').filter(Boolean)) {
      try {
        const rec = JSON.parse(l);
        if (!isObj(rec) || typeof rec.row !== 'string' || !Number.isInteger(rec.n) || rec.hmac !== spillHmac(rec.n as number, rec.row)) { dropped++; continue; } // forged or corrupt: drop
        const r = JSON.parse(rec.row);
        if (isObj(r)) authentic.push({ n: rec.n as number, row: r as SpillRow }); else dropped++;
      } catch { dropped++; }
    }
    const got = authentic.map((a) => a.n);
    const contiguous = got.length === want.length && got.every((n, i) => n === want[i]);
    if (contiguous) {
      for (const a of authentic) appendChained(dir, a.row);
    } else {
      // Fold what is authentic and outstanding, once each, in counter order —
      // the rows are genuinely ours and are not lost — then record the gap.
      const seen = new Set<number>();
      const ordered = authentic.filter((a) => a.n > st.folded && a.n <= st.written && !seen.has(a.n) && (seen.add(a.n), true)).sort((a, b) => a.n - b.n);
      for (const a of ordered) appendChained(dir, a.row);
      const missing = want.filter((n) => !seen.has(n));
      const list = (ns: number[]) => (ns.length > 20 ? `${ns.slice(0, 20).join(',')},… (${ns.length})` : ns.join(','));
      spillAlarm(dir, `own spill file audit.spill.${process.pid}.jsonl was edited by another process: expected counters ${want.length ? `${want[0]}-${want[want.length - 1]}` : 'none'} in order, found [${list(got)}]; missing [${list(missing)}]`);
    }
    if (dropped) process.stderr.write(`cairn-proxy: dropped ${dropped} unauthenticated or corrupt spill line(s) in audit.spill.${process.pid}.jsonl (not written by this process)\n`);
    st.folded = st.written;
    try { fs.unlinkSync(own); } catch { /* raced or unwritable: the next fold sees only duplicates and alarms */ }
  }
  // GC orphaned spill files from OTHER pids that are provably DEAD and stale.
  // Never fold them; just reclaim the space. Only a 'dead' pid qualifies, never
  // 'unknown' (ESRCH): on a shared volume that is a live holder in ANOTHER pid
  // namespace, and its spill — which its own fold now checks for continuity —
  // would be unlinked from under it after a minute of quiet, turning our GC into
  // exactly the "vanished spill file" alarm it raises. A crashed process's spill
  // therefore stays on disk; it is small, unfoldable by anyone, and a trace of
  // the crash rather than a hole in the log.
  try {
    for (const f of fs.readdirSync(dir)) {
      const m = /^audit\.spill\.(\d+)\.jsonl$/.exec(f);
      if (!m || Number(m[1]) === process.pid) continue;
      const fp = path.join(dir, f);
      try {
        const st = fs.statSync(fp);
        if (pidLiveness(Number(m[1])) === 'dead' && Date.now() - st.mtimeMs > LOCK_STALE_MS * 4) fs.unlinkSync(fp);
      } catch { /* raced */ }
    }
  } catch { /* dir unreadable */ }
}

const parsesAsObject = (line: string): boolean => { try { return isObj(JSON.parse(line)); } catch { return false; } };

/**
 * A crash- or ENOSPC-torn trailing line: the bytes after the file's last '\n'
 * are non-empty and do not parse as a JSON object. Every write here is a prefix
 * of `<json>\n`, so a torn write is always UNTERMINATED — a newline-terminated
 * garbage line is not a torn write and is never treated as one. Returns the
 * offset of the end of the last complete line (what the file should be
 * truncated to), or -1 when the tail is not torn — including when the
 * unterminated last line IS a complete entry (a crash between the JSON and its
 * newline), which must be kept. Bounded tail read, like diskHead.
 */
function tornTailOffset(file: string): number {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      if (size === 0) return -1;
      const want = Math.min(65536, size);
      let buf = Buffer.alloc(want);
      fs.readSync(fd, buf, 0, want, size - want);
      if (buf[want - 1] === 0x0a) return -1; // newline-terminated: not torn
      let nl = buf.lastIndexOf(0x0a);
      let base = size - want;
      if (nl === -1 && want < size) { buf = fs.readFileSync(file); nl = buf.lastIndexOf(0x0a); base = 0; } // one very long line: full read
      if (parsesAsObject(buf.subarray(nl + 1).toString('utf8'))) return -1;
      return base + nl + 1;
    } finally { fs.closeSync(fd); }
  } catch { return -1; }
}

/**
 * Truncate a torn trailing line so the file ends on its last complete entry.
 * MUST run under the lock. Before this, appendChained wrote PAST the torn line
 * (a leading '\n'), which kept the chain continuous but left the fragment in
 * the file as an interior unparseable line: verify reported CHAIN BROKEN at it
 * forever, anchorHead/rotateAudit/the daemon refused until someone hand-edited
 * the log, and a tenant could induce the whole state with one ENOSPC. Nothing
 * a verifier relies on is removed: the fragment was never a chained entry, and
 * a deliberate truncation INTO the last real entry is still caught by the head
 * sidecar and the anchors (the chain then ends below a checkpoint).
 */
function healTornTail(file: string): boolean {
  const at = tornTailOffset(file);
  if (at < 0) return false;
  try {
    fs.truncateSync(file, at);
    process.stderr.write(`cairn: truncated a torn trailing line in ${path.basename(file)} (a crash or ENOSPC mid-write); the chain resumes from the last complete entry\n`);
    return true;
  } catch { return false; }
}

/** The raw chained append. MUST run under the lock: it reads the true disk head
 * and writes exactly one entry. */
function appendChained(dir: string, e: SpillRow): void {
  healTornTail(auditFile(dir));
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
    // appendAudit runs on the REQUEST path: sleepMs is a synchronous Atomics.wait
    // that blocks the gateway's event loop, so a long lock hold (the daemon
    // verifying/anchoring across a big corpus) must NOT make every tenant's call
    // spin the full 3s. Cap the wait sharply (default 40ms) and SPILL on contention
    // — the spill/fold machinery folds it into the chain, in order, on the next
    // uncontended write, so nothing is lost and the loop is never stalled for long
    // (red-team DoS 1.8). Daemon-side anchorHead/rotateAudit keep the longer wait.
    const appendWaitMs = Math.max(0, Number(process.env.CAIRN_AUDIT_APPEND_WAIT_MS) || 40);
    const r = withAuditLock(dir, () => {
      foldSpills(dir);        // bring any spilled rows into the chain first, in order
      appendChained(dir, e);  // then our own, off the true disk head
    }, appendWaitMs);
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

// A parsed JSONL line is usable only if it is a plain object (isObj, above):
// `null`, a number, a string, or an array all parse WITHOUT throwing but carry
// no fields, so a later property access on them throws where the try/catch can
// no longer see it — the exact way an appended `null` turned the audit tamper
// check into an uncaught throw.
export function readAnchors(dir: string): Anchor[] {
  try {
    return fs.readFileSync(anchorFile(dir), 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { const a = JSON.parse(l); return isObj(a) ? [a as unknown as Anchor] : []; } catch { return []; } });
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
  try {
    anchors = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
      const a = JSON.parse(l); // a malformed off-box anchor line is a tamper signal, not a skip
      if (!isObj(a)) throw new Error('anchor line is not a JSON object');
      return a as unknown as Anchor;
    });
  }
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
  // A cursor that names an anchor NO LONGER in the log means the anchor log was
  // truncated below what was already shipped. Re-shipping from index 0 would push a
  // second, conflicting chain off-box (confusing the operator's verify) — refuse
  // and drop an alarm instead (red-team audit gap 3). verifyAudit flags the same.
  if (cursor && at === -1) {
    try { fs.writeFileSync(shipAlarm(dir), JSON.stringify({ at: new Date().toISOString(), detail: 'shipped cursor names an anchor absent from the log — refusing to re-ship a conflicting chain (possible tampering)' }) + '\n'); } catch { /* best-effort */ }
    return;
  }
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
      // A torn trailing line in either file (a crash mid-write) is healed here,
      // under the lock, so it never becomes a permanent refusal to anchor.
      healTornTail(auditFile(dir));
      healTornTail(anchorFile(dir));
      // Never anchor a broken log: an anchor of a forgery launders it into the
      // trust root. Verify under the lock so no append moves the head first. This
      // is an on-box LIVENESS check with no off-box anchors to pass, so it bridges
      // DECLARED offloads (offloadArchive marked them, boundary shipped off-box)
      // rather than failing forever once an archive is offloaded (Fable-6 #2).
      const v = verifyAudit(dir, { trustDeclaredOffload: true });
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
  /** Off-loaded archives trusted by an off-box boundary anchor rather than
   * walked on the box — the interior was not re-hashed here. lastHash is
   * included so a watcher (the daemon) can key on the full bridged RANGE, not
   * the filename alone. */
  bridged?: { file: string; firstSeq: number; lastSeq: number; lastHash: string }[];
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
export interface Segment { file: string; firstSeq: number; lastSeq: number; firstPrevHash: string; lastHash: string; offloaded?: boolean; }
const segmentsFile = (dir: string) => path.join(dir, 'audit.segments.jsonl');
export function readSegments(dir: string): Segment[] {
  try { return fs.readFileSync(segmentsFile(dir), 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { const s = JSON.parse(l); return isObj(s) ? [s as unknown as Segment] : []; } catch { return []; } }); } catch { return []; }
}

export function rotateAudit(dir: string): RotateResult {
  // Anchor the current head BEFORE the rotation lock (anchorHead takes its own
  // lock; it also refuses a broken log, so this doubles as the pre-check). The
  // boundary must be pinned off-box, so refuse to rotate if the ship failed.
  const finalAnchor = anchorHead(dir);
  // When off-box anchoring is IN USE, the boundary anchor MUST be shipped off-box
  // before we archive: once the live segment becomes an archive file, a deleted
  // archive is detectable only via an off-box anchor pinning its boundary (a local
  // anchor cannot bridge it — the adversary has box write). "In use" is not only
  // the env var this shell happens to have: a ship cursor on disk means anchors
  // have been shipped before, so an operator running `cairn:audit-log rotate` from
  // a shell WITHOUT the cmd must not quietly skip the guard and archive with an
  // unshippable boundary. If off-box anchoring is in use but the cmd is not
  // available here, refuse; if it is available but the ship failed, refuse.
  const offBoxInUse = !!process.env.CAIRN_AUDIT_ANCHOR_CMD || fs.existsSync(shippedCursor(dir));
  if (offBoxInUse) {
    if (!finalAnchor) return { ok: false, detail: 'refusing to rotate: could not anchor the head off-box first (the log is broken or empty)' };
    if (!process.env.CAIRN_AUDIT_ANCHOR_CMD) return { ok: false, detail: `refusing to rotate: off-box anchoring is in use (a ship cursor exists) but CAIRN_AUDIT_ANCHOR_CMD is not set in this shell — set it so the boundary anchor can ship, then retry.` };
    if (!anchorShipped(dir, finalAnchor)) return { ok: false, detail: `refusing to rotate: the boundary anchor (seq ${finalAnchor.seq}) did not ship off-box — CAIRN_AUDIT_ANCHOR_CMD failed. Fix it and retry; without it a later deletion of this archive could not be detected.` };
  }
  const r = withAuditLock(dir, (): RotateResult => {
    foldSpills(dir);
    healTornTail(auditFile(dir)); // never archive a torn fragment as an interior line
    // On-box liveness check (no off-box anchors here): bridge DECLARED offloads so
    // rotation is not permanently disabled once an archive is offloaded (Fable-6 #2).
    const v = verifyAudit(dir, { trustDeclaredOffload: true });
    if (!v.ok) return { ok: false, detail: `refusing to rotate a broken log: ${v.detail}` };
    let lines: string[];
    try { lines = fs.readFileSync(auditFile(dir), 'utf8').split('\n').filter(Boolean); } catch { return { ok: false, detail: 'no live segment to rotate' }; }
    if (!lines.length) return { ok: false, detail: 'the live segment is empty — nothing to rotate' };
    let first: AuditEntry | null = null;
    for (const l of lines) { try { first = JSON.parse(l) as AuditEntry; break; } catch { /* skip a corrupt leading line */ } }
    const tail = diskHead(dir);
    if (!first || tail.seq === 0) return { ok: false, detail: 'could not read the segment boundary' };
    // The boundary anchor was taken and shipped OUTSIDE this lock; appends in the
    // gap advance the head, so the archive we are about to cut (at `tail`, the
    // current head) can end at a LATER seq than the anchor. That anchor would then
    // pin a point INSIDE the archive, not its boundary — and a later deletion of
    // the archive could not be bridged (verify needs an off-box anchor at
    // seg.lastSeq). When off-box anchoring is in force, refuse rather than ship a
    // misaligned boundary; the caller re-anchors the new head and retries.
    if (process.env.CAIRN_AUDIT_ANCHOR_CMD && finalAnchor && tail.seq !== finalAnchor.seq) {
      return { ok: false, detail: `the head advanced from seq ${finalAnchor.seq} to ${tail.seq} after the boundary anchor was shipped; refusing to rotate so the archive boundary stays pinned off-box — retry.` };
    }
    const archiveName = `audit.${first.seq}-${tail.seq}.jsonl`;
    // Record the segment in the manifest FIRST, then archive the live file, then
    // START the new live segment with a real CHAINED marker entry (seq =
    // tail.seq+1, prevHash = tail.hash). No unauthenticated "carry" file: an
    // absent/empty live file is a deletion, and the new segment's first entry
    // chains from the archived head, so a forged boundary cannot make verify skip
    // anything. The manifest is written before the rename and its failure ABORTS
    // the rotation (live untouched): renaming first and swallowing a manifest
    // failure would leave an archive verify cannot find — a false CHAIN BROKEN on
    // the very next check, since the live marker's prevHash chains from a head
    // that then appears nowhere.
    // Capture the manifest length before the append so a later failure can ROLL
    // BACK the entry (or a partial append) — otherwise a phantom or half-written
    // manifest record makes every later verify a false CHAIN BROKEN. Only ENOENT
    // (no manifest yet) is a real "length 0"; any other stat error must NOT collapse
    // to 0, or a later rollback could truncate the whole manifest.
    let manifestLenBefore = 0;
    try { manifestLenBefore = fs.statSync(segmentsFile(dir)).size; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return { ok: false, detail: `could not read the segment manifest before rotating: ${(e as Error).message}` }; }
    try {
      fs.appendFileSync(segmentsFile(dir), JSON.stringify({ file: archiveName, firstSeq: first.seq, lastSeq: tail.seq, firstPrevHash: first.prevHash, lastHash: tail.hash } as Segment) + '\n');
    } catch (e) {
      // A partial append (ENOSPC mid-write) would leave a torn trailing line the
      // next append concatenates onto, silently losing a later segment. Truncate
      // back to the pre-append length so the manifest is exactly what it was.
      try { fs.truncateSync(segmentsFile(dir), manifestLenBefore); } catch { /* best-effort rollback */ }
      return { ok: false, detail: `could not record the segment manifest; left the live log intact: ${(e as Error).message}` };
    }
    try {
      fs.renameSync(auditFile(dir), path.join(dir, archiveName));
    } catch (e) {
      // The archive was not created: undo the manifest append so verify does not
      // see a record for a file that isn't there. Live log is untouched.
      try { fs.truncateSync(segmentsFile(dir), manifestLenBefore); } catch { /* best-effort rollback */ }
      return { ok: false, detail: `could not archive the live segment; rolled back the manifest and left the live log intact: ${(e as Error).message}` };
    }
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

export interface OffloadResult { ok: boolean; file?: string; freedBytes?: number; detail?: string; }

/**
 * Declare an archived segment OFF-loaded: verified once more on the box, its
 * boundary confirmed shipped off-box, marked `offloaded` in the manifest, and its
 * local copy removed to reclaim space. This is the SUPPORTED way to move an
 * archive off the machine — after it, the on-box liveness self-checks
 * (anchorHead/rotateAudit/daemon) bridge the gap via the declared flag instead of
 * failing forever (Fable-6 #2), while the operator's authoritative
 * `verify --against <off-box anchors>` still re-checks the range against the real
 * external anchor. Refuses unless:
 *   - the named segment exists and its local file is still present (so its
 *     contents get one final on-box hash-check before deletion),
 *   - the whole chain verifies (never offload out of a broken log), and
 *   - an off-box anchor pinning the segment boundary (seq, hash) has SHIPPED, so
 *     the range stays verifiable off the box after the local copy is gone.
 * Undeclared deletion of an archive remains a hard tamper failure everywhere.
 */
export function offloadArchive(dir: string, file: string): OffloadResult {
  // `file` is joined onto `dir` and unlinked, so it must be a bare archive
  // basename — never a path that could escape the audit dir.
  if (!/^audit\.\d+-\d+\.jsonl$/.test(file)) return { ok: false, detail: `not an archive filename: ${file} (expected audit.<from>-<to>.jsonl)` };
  const r = withAuditLock(dir, (): OffloadResult => {
    const segs = readSegments(dir);
    const idx = segs.findIndex((s) => s.file === file);
    if (idx === -1) return { ok: false, detail: `no archived segment named ${file} in the manifest` };
    const seg = segs[idx];
    const local = path.join(dir, file);
    const localSize = (): number | null => { try { return fs.statSync(local).size; } catch { return null; } };
    // Idempotent: a prior offload that marked the manifest but failed (or was
    // interrupted) before removing the local copy is COMPLETED here rather than
    // refused — the segment is already declared, so just finish the unlink.
    if (seg.offloaded) {
      const sz = localSize();
      if (sz === null) return { ok: true, file, freedBytes: 0, detail: 'already offloaded; local copy already gone' };
      try { fs.unlinkSync(local); } catch (e) { return { ok: false, detail: `already declared offloaded but could not remove the leftover local copy (${(e as Error).message}); delete ${local} by hand` }; }
      return { ok: true, file, freedBytes: sz, detail: 'already declared; removed the leftover local copy' };
    }
    const size = localSize();
    if (size === null) return { ok: false, detail: `${file} is not present locally — declare offload BEFORE moving it off-box so its contents can be verified one last time` };
    // Verify the whole chain (allowing prior declared offloads) before trusting
    // this one; never offload out of a broken log.
    const v = verifyAudit(dir, { trustDeclaredOffload: true });
    if (!v.ok) return { ok: false, detail: `refusing to offload: the log does not verify (${v.detail})` };
    // The boundary MUST be pinned by a shipped off-box anchor, or the range would
    // become permanently unverifiable off the box once the local copy is gone. A
    // segment rotated while off-box anchoring was not in use never had a boundary
    // anchor taken and cannot be offloaded at all — anchorHead only ever anchors
    // the CURRENT head, never a past boundary — so say that plainly.
    const anchor = readAnchors(dir).find((a) => a.seq === seg.lastSeq && a.hash === seg.lastHash);
    if (!anchor) return { ok: false, detail: `no anchor pins the boundary of ${file} (seq ${seg.lastSeq}). Off-box anchoring must have been in force when this segment was rotated; it cannot be offloaded retroactively.` };
    if (!anchorShipped(dir, anchor)) return { ok: false, detail: `the boundary anchor for ${file} (seq ${seg.lastSeq}) has not shipped off-box — set CAIRN_AUDIT_ANCHOR_CMD and ship it before offloading, so the range stays verifiable` };
    // Mark offloaded in the manifest (full rewrite), then remove the local copy.
    // Order: manifest first — if the unlink fails, the segment is still correctly
    // declared and a re-run finishes it; deleting first then failing the manifest
    // write would leave an undeclared absence (a false tamper alarm). The rewrite
    // is atomic (tmp + rename), so a concurrent unlocked verify never reads a
    // truncated manifest and a crash mid-write never corrupts it.
    const next = segs.map((s, i) => (i === idx ? { ...s, offloaded: true } : s));
    const tmp = path.join(dir, `.segments.${process.pid}.tmp`);
    try {
      fs.writeFileSync(tmp, next.map((s) => JSON.stringify(s)).join('\n') + '\n');
      fs.renameSync(tmp, segmentsFile(dir));
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
      return { ok: false, detail: `could not update the manifest; nothing removed: ${(e as Error).message}` };
    }
    try { fs.unlinkSync(local); } catch (e) {
      return { ok: false, detail: `declared offloaded, but could not remove the local copy (${(e as Error).message}); delete ${local} by hand` };
    }
    return { ok: true, file, freedBytes: size };
  });
  if (!r.locked) return { ok: false, detail: 'could not take the audit lock to offload' };
  return r.value!;
}

/** Re-walk the chain and confirm every hash. Detects any edit, deletion, or
 * reordering of committed entries — and, via the head sidecar and the anchors,
 * a whole-file rewrite or a tail truncation that the in-file chain alone cannot
 * see. Pass `against` to require the live chain to still match anchors an
 * operator is holding OFF the box (the real defense against a box-level
 * attacker): each is `{ seq, hash }` from a `cairn:audit-log anchor` they saved
 * elsewhere. */
export function verifyAudit(dir: string, opts: { against?: { seq: number; hash: string }[]; trustDeclaredOffload?: boolean; offloaded?: string[] } = {}): AuditVerdict {
  // Read the cross-checks (anchors + head sidecar) BEFORE the log. Both are
  // written strictly AFTER the log line they describe, so a log read taken
  // afterwards is always at least as advanced — which means a concurrent append
  // can never make a clean log look "truncated" (the false-alarm race). Reading
  // the log first had the opposite order and fired spurious truncation alarms.
  const anchors = readAnchors(dir);
  const sc = readHeadSidecar(dir);

  // STRICT anchor parse (red-team audit gap 3): readAnchors DROPS a malformed line,
  // so corrupting the last anchor line reads exactly like deleting it — silently.
  // A non-empty anchor line that is not a JSON object is tampering, not a skip.
  try {
    const rawAnchors = fs.readFileSync(anchorFile(dir), 'utf8');
    const rawAnchorLines = rawAnchors.split('\n').filter(Boolean);
    // One UNTERMINATED, unparseable LAST line is a torn anchor write (a crash
    // mid-append), not tampering: it was never a complete anchor, readAnchors
    // already drops it, and the next anchorHead truncates it under the lock. A
    // newline-terminated garbage line, or garbage anywhere else, stays tampering.
    if (rawAnchorLines.length && !rawAnchors.endsWith('\n') && !parsesAsObject(rawAnchorLines[rawAnchorLines.length - 1])) rawAnchorLines.pop();
    for (let i = 0; i < rawAnchorLines.length; i++) {
      let parsed: unknown;
      try { parsed = JSON.parse(rawAnchorLines[i]); } catch { return { ok: false, entries: 0, detail: `the anchor log has a malformed line (#${i + 1}) — anchors were tampered with` }; }
      if (!isObj(parsed)) return { ok: false, entries: 0, detail: `the anchor log has a non-object line (#${i + 1}) — anchors were tampered with` };
    }
  } catch { /* no anchor file yet — nothing shipped, nothing to check */ }
  // The shipped cursor names the last anchor pushed OFF-box. It is only ever
  // advanced to an anchor that exists in anchors.jsonl, so a non-empty cursor whose
  // anchor is no longer present means the anchor log was truncated below what was
  // already shipped — detectable even without the off-box copy in hand (gap 3).
  try {
    const cursor = fs.readFileSync(shippedCursor(dir), 'utf8').trim();
    if (cursor && !anchors.some((a) => a.anchorHash === cursor)) {
      return { ok: false, entries: 0, detail: 'the anchor log was truncated below the shipped cursor — an already-shipped anchor is gone (tampering)' };
    }
  } catch { /* no cursor — off-box shipping not in use */ }

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
  const bridged: { file: string; firstSeq: number; lastSeq: number; lastHash: string }[] = []; // archives trusted by an off-box boundary anchor, not walked
  const st = { prev: GENESIS, expectedSeq: 1, lastSeq: 0 };
  const walk = (lines: string[], where: string): AuditVerdict | null => {
    for (let i = 0; i < lines.length; i++) {
      let e: AuditEntry;
      // A non-object JSON line (`null`, `42`, `"x"`, `[]`) parses WITHOUT throwing,
      // so it must be rejected explicitly — otherwise `e.prevHash` throws a
      // TypeError that escapes verify. An attacker with append access could
      // otherwise append `null` to turn the tamper check into an uncaught throw
      // (silently swallowed by the daemon's catch) instead of a CHAIN BROKEN.
      try {
        const parsed = JSON.parse(lines[i]);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        e = parsed as AuditEntry;
      } catch { return { ok: false, entries: st.lastSeq, brokenAt: i + 1, detail: `${where}: line is not a JSON object` }; }
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
    // The archive FILENAME encodes the true range — rotateAudit always names it
    // `audit.<first>-<last>.jsonl` — so a manifest record whose firstSeq/lastSeq
    // disagree with its own `file` was rewritten after the fact. Without this
    // check a box-write attacker who legitimately offloaded audit.1-10.jsonl
    // could stretch that ONE record's lastSeq/lastHash to a later real (shipped)
    // boundary, delete the intervening archives and their records, and have both
    // the liveness and the authoritative verify bridge the whole 1-30 range as a
    // single declared offload — history deleted, no alarm. Checked BEFORE the
    // file is read, so a present archive under a stretched record fails too.
    if (!Number.isInteger(seg.firstSeq) || !Number.isInteger(seg.lastSeq) || seg.file !== `audit.${seg.firstSeq}-${seg.lastSeq}.jsonl`) {
      return { ok: false, entries: st.lastSeq, detail: `manifest record for ${seg.file} claims seq ${seg.firstSeq}-${seg.lastSeq}, which its filename does not encode — the segment manifest was rewritten` };
    }
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
      //
      // The ONE exception is a LIVENESS check (trustDeclaredOffload): the on-box
      // self-checks in anchorHead/rotateAudit/daemon have no off-box anchors to
      // pass, so once an operator legitimately offloads an archive they would
      // otherwise fail forever — permanently disabling anchoring and rotation, so
      // the live log grows unbounded and no new checkpoints ship (Fable-6 #2). For
      // those callers a segment DECLARED offloaded (offloadArchive marked it, after
      // requiring its boundary anchor to be shipped off-box) is bridged. But the
      // FLAG ALONE is not enough even here: the liveness bridge additionally
      // requires a LOCAL anchor pinning the boundary that has SHIPPED off-box —
      // exactly what offloadArchive demanded. So a forged `offloaded:true` on a
      // segment whose boundary was never anchored and shipped (an archive simply
      // deleted to hide it) is refused even by the lenient on-box check. This trades
      // nothing real: the offloaded range is off-box, so only the operator's
      // `verify --against <off-box anchors>` — which does NOT set trustDeclaredOffload
      // — can vouch for it, and that path still demands the true external anchor.
      const boundary = externalAt.get(seg.lastSeq);
      const externallyPinned = boundary !== undefined && boundary === seg.lastHash;
      const namedOffloaded = opts.offloaded?.includes(seg.file) ?? false;
      let bridgeOk: boolean;
      let why: string;
      if (opts.trustDeclaredOffload === true) {
        // LIVENESS (daemon/anchorHead/rotateAudit): no off-box anchors to pass, so
        // bridge a DECLARED offload with a shipped boundary anchor. This can be
        // fabricated by a box-write attacker reusing a real shipped anchor as the
        // boundary of a segment that never existed — so the daemon does NOT trust
        // this alone: it alarms on a NOVEL bridge and refuses to anchor (audit
        // gap 1), and the authoritative check below never runs in this mode.
        bridgeOk = seg.offloaded === true
          && (() => { const a = anchors.find((x) => x.seq === seg.lastSeq && x.hash === seg.lastHash); return !!a && anchorShipped(dir, a); })();
        why = seg.offloaded
          ? `archive ${seg.file} (seq ${seg.firstSeq}-${seg.lastSeq}) is declared offloaded but no shipped off-box anchor pins its boundary`
          : `archive ${seg.file} (seq ${seg.firstSeq}-${seg.lastSeq}) is not present and is not declared offloaded`;
      } else {
        // AUTHORITATIVE (operator, `verify --against`): an off-box anchor must pin
        // the boundary AND the operator must have NAMED this file offloaded
        // (`--offloaded`). Pinning alone is not consent: an attacker chooses which
        // genuine shipped anchor to fabricate an "offloaded" segment over, so only
        // the operator — who knows what they actually moved off-box — can vouch for
        // an absent archive (audit gap 1).
        bridgeOk = externallyPinned && namedOffloaded;
        why = !externallyPinned
          ? `archive ${seg.file} (seq ${seg.firstSeq}-${seg.lastSeq}) is not present and no off-box anchor pins its boundary — its history cannot be verified`
          : `archive ${seg.file} (seq ${seg.firstSeq}-${seg.lastSeq}) is absent and its boundary is externally pinned, but it was not declared offloaded — name it with --offloaded if you moved it off-box, else this is a deletion`;
      }
      if (!bridgeOk) return { ok: false, entries: st.lastSeq, detail: why };
      if (st.expectedSeq !== seg.firstSeq || st.prev !== seg.firstPrevHash) return { ok: false, entries: st.lastSeq, detail: `archive ${seg.file} does not link to the previous segment` };
      // The off-box anchor pins this segment's boundary and it links to the prior
      // segment, so its endpoints are trusted. Any checkpoint that falls INSIDE
      // the absent archive (an interior anchor from a per-tick anchorHead) cannot
      // be checked against an entry that is no longer on the box — but it must not
      // false-alarm as a truncation/deletion either. Its hash is already
      // determined by the boundary chain the external anchor pins, so mark every
      // expected seq in the segment's range as matched (bridged, not re-verified).
      for (const [seq] of expectAtSeq) if (seq >= seg.firstSeq && seq <= seg.lastSeq) matched.add(seq);
      bridged.push({ file: seg.file, firstSeq: seg.firstSeq, lastSeq: seg.lastSeq, lastHash: seg.lastHash });
      st.prev = seg.lastHash; st.expectedSeq = seg.lastSeq + 1; st.lastSeq = seg.lastSeq;
    }
  }

  let live: string[];
  let tornLive = false;
  try {
    const raw = fs.readFileSync(auditFile(dir), 'utf8');
    live = raw.split('\n').filter(Boolean);
    // A SINGLE unterminated, unparseable LAST line is a torn write — a crash or
    // ENOSPC mid-append — not an edit: every append is a prefix of `<json>\n`, so a
    // torn one never ends in a newline, and it was never a chained entry (the
    // sidecar is written only after a complete line). It is set aside here and
    // truncated by the next locked write. This cannot mask a deletion: it applies
    // only to the last line, an interior fragment still fails at its line, and a
    // truncation INTO the last real entry leaves the chain ending below the head
    // sidecar / an anchor, which the checkpoint pass below reports. Before this,
    // one torn line was a permanent CHAIN BROKEN that halted anchoring, rotation
    // and the daemon until the log was hand-edited.
    if (live.length && !raw.endsWith('\n') && !parsesAsObject(live[live.length - 1])) { live.pop(); tornLive = true; }
  } catch { live = []; }
  const liveResult = walk(live, 'live segment');
  if (liveResult) return liveResult;

  // Any checkpoint not seen in the chain: beyond the end is a truncation; a gap
  // inside is a deletion. Either way the log lost entries a checkpoint pins.
  for (const [seq] of expectAtSeq) {
    if (!matched.has(seq)) return { ok: false, entries: st.lastSeq, detail: `a published checkpoint exists for seq ${seq} but the chain ends at ${st.lastSeq} — entries were truncated or deleted` };
  }

  if (st.lastSeq === 0) return { ok: true, entries: 0, detail: 'no audit log yet' };
  // Distinguish "walked and hash-checked" from "trusted by an off-box boundary
  // anchor" (an offloaded archive): the operator should know an interior range was
  // not re-hashed on the box, only pinned at its boundary.
  const notes: string[] = [];
  if (bridged.length) notes.push(`bridged ${bridged.length} off-loaded archive(s)${opts.trustDeclaredOffload ? ' (declared offload, not re-hashed on the box)' : ' via off-box anchors'}: ${bridged.map((b) => `${b.file} (seq ${b.firstSeq}-${b.lastSeq})`).join(', ')}`);
  // Said out loud, not hidden: an operator should know the file carries a torn
  // fragment until the next write truncates it.
  if (tornLive) notes.push('the live segment ends in a torn, unterminated line (a crash or ENOSPC mid-append); it is not a chained entry and the next locked write truncates it');
  return { ok: true, entries: st.lastSeq, bridged, detail: notes.length ? notes.join('; ') : undefined };
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
    try { const e = JSON.parse(l); if (isObj(e)) out.push(e as unknown as AuditEntry); } catch { /* skip a corrupt line */ }
  }
  return out;
}

/** Reset the in-process head cache — tests build many logs in one process. */
export function _resetAuditCache(): void {
  heads.clear();
}
