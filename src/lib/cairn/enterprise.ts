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
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { homePath } from './home';
import { WRITE_LOOKING, type Annotations } from './toolsurface';

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
  const role = policy.roles[principal.role];
  if (!role) return { allowed: false, reason: `role "${principal.role}" is not defined in the org policy` };
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
    const namedWrite = WRITE_LOOKING.test(tool.name);
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

function withAuditLock<T>(dir: string, fn: () => T): T {
  const lp = lockPath(dir);
  const deadline = Date.now() + 2000;
  let fd: number | undefined;
  for (;;) {
    try { fd = fs.openSync(lp, 'wx'); break; } // atomic exclusive create
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') { return fn(); } // can't lock at all: don't drop the row
      // Break a stale lock (a process that crashed holding it).
      try { if (Date.now() - fs.statSync(lp).mtimeMs > 5000) { fs.unlinkSync(lp); continue; } } catch { continue; }
      if (Date.now() > deadline) return fn(); // sustained contention: proceed unlocked rather than block the call
      sleepMs(5);
    }
  }
  try { return fn(); } finally { try { fs.closeSync(fd!); fs.unlinkSync(lp); } catch { /* already released */ } }
}

/** The chain head as it is ON DISK right now — the last parseable entry, read
 * from a bounded tail so an append does not cost a full-file read. Also reports
 * whether the file ends in a newline (so an append after a crash-truncated line
 * does not fuse onto it) and its size. */
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
    withAuditLock(dir, () => {
      const tail = diskHead(dir); // true head under the lock, so concurrent processes never interleave off a stale seq
      const seq = tail.seq + 1;
      const partial = { seq, at: e.at ?? new Date().toISOString(), principal: e.principal, decision: e.decision, server: e.server, tool: e.tool, reason: e.reason, session: e.session, agent: e.agent };
      const hash = chainHash(tail.hash, partial);
      const entry: AuditEntry = { ...partial, prevHash: tail.hash, hash };
      // A crash-truncated tail line has no trailing newline; start on a fresh
      // line so our valid entry is not fused onto the garbage.
      const lead = !tail.empty && !tail.endsWithNL ? '\n' : '';
      fs.appendFileSync(auditFile(dir), lead + JSON.stringify(entry) + '\n');
      writeHeadSidecar(dir, { seq, hash, at: entry.at });
      heads.set(dir, { seq, hash });
    });
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

function shipAnchor(a: Anchor): void {
  const cmd = process.env.CAIRN_AUDIT_ANCHOR_CMD;
  if (!cmd) return;
  try {
    execFileSync('/bin/sh', ['-c', cmd], { input: JSON.stringify(a) + '\n', timeout: 10_000, stdio: ['pipe', 'ignore', 'ignore'] });
  } catch (err) {
    process.stderr.write(`cairn: audit anchor ship failed (kept locally): ${(err as Error).message}\n`);
  }
}

/** Checkpoint the current chain head as an anchor: chain it, append it, and ship
 * it off-box. Returns the anchor, or null when there is nothing to anchor or the
 * head is already anchored. Runs under the same lock as append. */
export function anchorHead(dir: string): Anchor | null {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return withAuditLock(dir, () => {
      const tail = diskHead(dir);
      if (tail.empty || tail.seq === 0) return null;
      const existing = readAnchors(dir);
      const prevAnchorHash = existing.length ? existing[existing.length - 1].anchorHash : GENESIS;
      if (existing.length && existing[existing.length - 1].seq === tail.seq && existing[existing.length - 1].hash === tail.hash) return existing[existing.length - 1]; // head unchanged since last anchor
      const at = new Date().toISOString();
      const anchor: Anchor = { seq: tail.seq, hash: tail.hash, at, prevAnchorHash, anchorHash: anchorChainHash(prevAnchorHash, { seq: tail.seq, hash: tail.hash, at }) };
      let lead = '';
      try { const b = fs.readFileSync(anchorFile(dir)); if (b.length && b[b.length - 1] !== 0x0a) lead = '\n'; } catch { /* no file yet */ }
      fs.appendFileSync(anchorFile(dir), lead + JSON.stringify(anchor) + '\n');
      shipAnchor(anchor);
      return anchor;
    });
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

/** Re-walk the chain and confirm every hash. Detects any edit, deletion, or
 * reordering of committed entries — and, via the head sidecar and the anchors,
 * a whole-file rewrite or a tail truncation that the in-file chain alone cannot
 * see. Pass `against` to require the live chain to still match anchors an
 * operator is holding OFF the box (the real defense against a box-level
 * attacker): each is `{ seq, hash }` from a `cairn:audit-log anchor` they saved
 * elsewhere. */
export function verifyAudit(dir: string, opts: { against?: { seq: number; hash: string }[] } = {}): AuditVerdict {
  let lines: string[];
  try {
    lines = fs.readFileSync(auditFile(dir), 'utf8').split('\n').filter(Boolean);
  } catch {
    return { ok: true, entries: 0, detail: 'no audit log yet' };
  }

  // What the chain must match: local anchors (verified as a chain first), any
  // externally-held anchors, and the head sidecar. Keyed by seq → expected hash.
  const expectAtSeq = new Map<number, string>();
  const anchors = readAnchors(dir);
  let prevA = GENESIS;
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    if (a.prevAnchorHash !== prevA || anchorChainHash(prevA, { seq: a.seq, hash: a.hash, at: a.at }) !== a.anchorHash) {
      return { ok: false, entries: 0, detail: `the anchor log is inconsistent at anchor #${i + 1} — anchors were tampered with` };
    }
    expectAtSeq.set(a.seq, a.hash);
    prevA = a.anchorHash;
  }
  for (const ext of opts.against ?? []) expectAtSeq.set(ext.seq, ext.hash);

  let prev = GENESIS;
  let expectedSeq = 1;
  let lastSeq = 0;
  for (let i = 0; i < lines.length; i++) {
    let e: AuditEntry;
    try { e = JSON.parse(lines[i]) as AuditEntry; } catch { return { ok: false, entries: i, brokenAt: i + 1, detail: 'line is not JSON' }; }
    if (e.prevHash !== prev) return { ok: false, entries: i, brokenAt: i + 1, detail: 'prevHash does not match the previous entry (deletion or reorder)' };
    if (e.seq !== expectedSeq) return { ok: false, entries: i, brokenAt: i + 1, detail: `seq ${e.seq} out of order (expected ${expectedSeq})` };
    const recomputed = chainHash(prev, { seq: e.seq, at: e.at, principal: e.principal, decision: e.decision, server: e.server, tool: e.tool, reason: e.reason, session: e.session, agent: e.agent });
    if (recomputed !== e.hash) return { ok: false, entries: i, brokenAt: i + 1, detail: 'hash does not match contents (entry was edited)' };
    const anchored = expectAtSeq.get(e.seq);
    if (anchored !== undefined && anchored !== e.hash) return { ok: false, entries: i, brokenAt: i + 1, detail: `entry at seq ${e.seq} does not match a published anchor — the log was rewritten` };
    prev = e.hash;
    lastSeq = e.seq;
    expectedSeq += 1;
  }

  // A truncation drops the TAIL, which still verifies clean above. Catch it two
  // ways: an anchor (local or external) for a seq beyond the current end, and
  // the head sidecar recording a seq we no longer reach.
  for (const [seq, hash] of expectAtSeq) {
    if (seq > lastSeq) return { ok: false, entries: lines.length, detail: `the log ends at seq ${lastSeq} but a published anchor exists for seq ${seq} — entries were truncated` };
    void hash;
  }
  const sc = readHeadSidecar(dir);
  if (sc && typeof sc.seq === 'number') {
    if (sc.seq > lastSeq) return { ok: false, entries: lines.length, detail: `the recorded head is seq ${sc.seq} but the log ends at seq ${lastSeq} — entries were truncated` };
    if (sc.seq === lastSeq && sc.hash !== prev) return { ok: false, entries: lines.length, detail: 'the recorded head hash does not match the log tail — the log was rewritten' };
  }

  return { ok: true, entries: lines.length };
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
