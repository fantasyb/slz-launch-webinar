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
import { homePath } from './home';
import { WRITE_LOOKING, type Annotations } from './toolsurface';

/* ---- policy ------------------------------------------------------------- */

export interface Principal {
  id: string;
  role: string;
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

export function loadOrgPolicy(): OrgPolicy | null {
  const p = orgPolicyPath();
  if (!p) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<OrgPolicy>;
    if (!raw || typeof raw !== 'object') return null;
    return {
      auth: { required: raw.auth?.required === true },
      principals: (raw.principals && typeof raw.principals === 'object' ? raw.principals : {}) as Record<string, Principal>,
      roles: (raw.roles && typeof raw.roles === 'object' ? raw.roles : {}) as Record<string, Role>,
    };
  } catch {
    return null;
  }
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
  tool: { name: string; annotations?: Annotations | null },
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
  if (role.denyTools?.includes(tool.name)) return { allowed: false, reason: `role "${principal.role}" is denied tool "${tool.name}"` };
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
  prevHash: string;
  hash: string;
}

const GENESIS = '0'.repeat(64);
const auditFile = (dir: string) => path.join(dir, 'audit.jsonl');

/** Stable serialization of the signed fields, so the hash is reproducible. */
function chainHash(prevHash: string, e: Omit<AuditEntry, 'prevHash' | 'hash'>): string {
  const body = JSON.stringify([e.seq, e.at, e.principal, e.decision, e.server ?? '', e.tool ?? '', e.reason ?? '']);
  return createHash('sha256').update(prevHash).update('\n').update(body).digest('hex');
}

/* In-process chain head per audit dir, so an append does not re-read the whole
 * file each call. Seeded once from the file's last line. Appends within one
 * process are ordered (synchronous appendFileSync), which keeps the chain sound
 * for the single hosted process this is designed for. */
const heads = new Map<string, { seq: number; hash: string }>();

function head(dir: string): { seq: number; hash: string } {
  const cached = heads.get(dir);
  if (cached) return cached;
  let seq = 0;
  let hash = GENESIS;
  try {
    const lines = fs.readFileSync(auditFile(dir), 'utf8').split('\n').filter(Boolean);
    if (lines.length) {
      const last = JSON.parse(lines[lines.length - 1]) as AuditEntry;
      if (typeof last.seq === 'number' && typeof last.hash === 'string') { seq = last.seq; hash = last.hash; }
    }
  } catch {
    /* no log yet: genesis */
  }
  const h = { seq, hash };
  heads.set(dir, h);
  return h;
}

/** Append one tamper-evident audit entry. Best-effort: a log that cannot be
 * written must never break a tool call, but the failure is loud on stderr. */
export function appendAudit(dir: string, e: { at?: string; principal: string; decision: AuditDecision; server?: string; tool?: string; reason?: string }): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const h = head(dir);
    const seq = h.seq + 1;
    const partial = { seq, at: e.at ?? new Date().toISOString(), principal: e.principal, decision: e.decision, server: e.server, tool: e.tool, reason: e.reason };
    const hash = chainHash(h.hash, partial);
    const entry: AuditEntry = { ...partial, prevHash: h.hash, hash };
    fs.appendFileSync(auditFile(dir), JSON.stringify(entry) + '\n');
    heads.set(dir, { seq, hash });
  } catch (err) {
    process.stderr.write(`cairn-proxy: could not write audit entry: ${(err as Error).message}\n`);
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
 * reordering of committed entries. */
export function verifyAudit(dir: string): AuditVerdict {
  let lines: string[];
  try {
    lines = fs.readFileSync(auditFile(dir), 'utf8').split('\n').filter(Boolean);
  } catch {
    return { ok: true, entries: 0, detail: 'no audit log yet' };
  }
  let prev = GENESIS;
  let expectedSeq = 1;
  for (let i = 0; i < lines.length; i++) {
    let e: AuditEntry;
    try { e = JSON.parse(lines[i]) as AuditEntry; } catch { return { ok: false, entries: i, brokenAt: i + 1, detail: 'line is not JSON' }; }
    if (e.prevHash !== prev) return { ok: false, entries: i, brokenAt: i + 1, detail: 'prevHash does not match the previous entry (deletion or reorder)' };
    if (e.seq !== expectedSeq) return { ok: false, entries: i, brokenAt: i + 1, detail: `seq ${e.seq} out of order (expected ${expectedSeq})` };
    const recomputed = chainHash(prev, { seq: e.seq, at: e.at, principal: e.principal, decision: e.decision, server: e.server, tool: e.tool, reason: e.reason });
    if (recomputed !== e.hash) return { ok: false, entries: i, brokenAt: i + 1, detail: 'hash does not match contents (entry was edited)' };
    prev = e.hash;
    expectedSeq += 1;
  }
  return { ok: true, entries: lines.length };
}

export function readAudit(dir: string, limit?: number): AuditEntry[] {
  try {
    const lines = fs.readFileSync(auditFile(dir), 'utf8').split('\n').filter(Boolean);
    const chosen = limit && limit > 0 ? lines.slice(-limit) : lines;
    return chosen.map((l) => JSON.parse(l) as AuditEntry);
  } catch {
    return [];
  }
}

/** Reset the in-process head cache — tests build many logs in one process. */
export function _resetAuditCache(): void {
  heads.clear();
}
