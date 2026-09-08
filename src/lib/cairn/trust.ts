/**
 * The trust pin — the security half of the gateway.
 *
 * An MCP tool's description and schema are read by the MODEL, not the human who
 * approved the server. So a server that is benign when you install it and
 * hostile after — a new instruction slipped into a description, an argument
 * added to exfiltrate, a read-only tool quietly flipped to a write, a whole new
 * tool that appeared unapproved — is the defining MCP attack (tool poisoning,
 * the rug pull). The gateway is the one component that sees every server's tool
 * surface on every session, so it is the place to PIN what was approved and
 * refuse to hand the model a tool that changed under it.
 *
 * This module owns the pin: where it lives, reading and writing it, and the
 * verdict — which live tools drifted from the approved surface, and which of
 * those a security-conscious gateway should withhold. The comparison itself is
 * `diffSurface` (toolsurface.ts), the same primitive the gateway already uses to
 * notice a finding rotting; here it is pointed at the approved baseline instead
 * of the session baseline, and its output drives a security decision.
 *
 * Modes (CAIRN_TRUST_MODE): `off` does nothing; `monitor` pins on first sight
 * and FLAGS drift without blocking (safe, non-breaking — the install default);
 * `enforce` additionally WITHHOLDS a changed or unapproved tool until it is
 * re-approved. Pins live under CAIRN_HOME/trust/<server>.json, admin territory
 * like the execution policy.
 */
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { diffSurface, type ToolShape, type SurfaceChange } from './toolsurface';

export type TrustMode = 'off' | 'monitor' | 'enforce';

export function trustMode(): TrustMode {
  const m = (process.env.CAIRN_TRUST_MODE ?? 'off').toLowerCase();
  return m === 'monitor' || m === 'enforce' ? m : 'off';
}

/** Explicit bootstrap never creates or extends approvals in the gateway. */
export function trustBootstrap(): 'tofu' | 'explicit' {
  const mode = (process.env.CAIRN_TRUST_BOOTSTRAP ?? 'tofu').toLowerCase();
  if (mode !== 'tofu' && mode !== 'explicit') throw new Error('CAIRN_TRUST_BOOTSTRAP must be tofu or explicit');
  if (mode === 'explicit' && trustMode() !== 'enforce') throw new Error('Explicit approval requires CAIRN_TRUST_MODE=enforce');
  return mode;
}

export interface Pin {
  server: string;
  approvedAt: string;
  /** The approved surface: every tool's name, description, annotations, schema hash. */
  tools: ToolShape[];
  /**
   * The server's own `instructions` at approval time. The model reads these
   * exactly as it reads a tool description, so a server that slips a new
   * instruction in here after approval is the same rug-pull as one that
   * rewrites a tool description — pinned and checked on the same footing.
   * Optional so a pin written before this field existed still loads (treated as
   * empty, which a real instructions string will correctly read as drift).
   */
  instructions?: string;
  /**
   * The approved PROMPT surface (prompts/list): every prompt's name, title,
   * description and argument list, as ToolShape via promptShapeOf. The model
   * reads a prompt's description and arguments exactly as it reads a tool's, so
   * a prompt rewritten after approval is the same rug-pull, pinned and checked
   * on the same footing. ABSENT (not empty) in a pin written before prompts were
   * covered, or before the server's prompts were first listed: that means "not
   * yet approved", and the gateway pins the prompt channel on its next complete
   * listing (trust on first use for that channel alone) rather than reading
   * every existing prompt as `appeared` and withholding them all on upgrade.
   */
  prompts?: ToolShape[];
}

const safeName = (s: string) => s.replace(/[^A-Za-z0-9_.-]+/g, '_') || 'server';
export function pinPath(server: string, trustDir: string): string {
  // A short hash of the RAW server name disambiguates pins whose sanitized names
  // collide ("a/b" and "a_b" both sanitize to "a_b") — otherwise one server's
  // approval could be read as another's, defeating the pin. The readable prefix
  // stays for humans browsing the dir.
  const tag = createHash('sha256').update(server).digest('hex').slice(0, 8);
  return path.join(trustDir, `${safeName(server)}.${tag}.json`);
}

export type PinState = { status: 'valid'; pin: Pin } | { status: 'missing' } | { status: 'invalid' };

function validShapes(value: unknown): value is ToolShape[] {
  if (!Array.isArray(value)) return false;
  const names = new Set<string>();
  return value.every((s) => {
    if (!s || typeof s !== 'object' || typeof s.name !== 'string' || names.has(s.name)) return false;
    names.add(s.name);
    return typeof s.description === 'string'
      && (s.annotations === null || (typeof s.annotations === 'object' && !Array.isArray(s.annotations)))
      && Array.isArray(s.properties) && s.properties.every((p: unknown) => typeof p === 'string')
      && typeof s.schemaHash === 'string' && /^[a-f0-9]{64}$/.test(s.schemaHash)
      && (s.title === undefined || typeof s.title === 'string')
      && (s.outputSchemaHash === undefined || (typeof s.outputSchemaHash === 'string' && /^[a-f0-9]{64}$/.test(s.outputSchemaHash)));
  });
}

/** Missing is eligible for first use; corrupt or unreadable evidence is not. */
export function readPinState(server: string, trustDir: string): PinState {
  let raw: string;
  try {
    raw = fs.readFileSync(pinPath(server, trustDir), 'utf8');
  } catch (error) {
    return { status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'invalid' };
  }
  const pin = parsePin(server, raw);
  return pin ? { status: 'valid', pin } : { status: 'invalid' };
}

/** Validate review material without granting approval or touching storage. */
export function parsePin(server: string, raw: string): Pin | null {
  try {
    const p = JSON.parse(raw) as Pin;
    if (!p || p.server !== server || typeof p.approvedAt !== 'string' || !Number.isFinite(Date.parse(p.approvedAt))
      || !validShapes(p.tools) || (p.instructions !== undefined && typeof p.instructions !== 'string')
      || (p.prompts !== undefined && !validShapes(p.prompts))) return null;
    return p;
  } catch {
    return null;
  }
}

/** Approve the exact reviewed bytes for an explicit server identity. */
export function approvePin(server: string, raw: string, expectedSha256: string, trustDir: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256) || createHash('sha256').update(raw).digest('hex') !== expectedSha256) return false;
  const pin = parsePin(server, raw);
  if (!pin) return false;
  return persistPin({ ...pin, approvedAt: new Date().toISOString() }, trustDir);
}

export function readPin(server: string, trustDir: string): Pin | null {
  const state = readPinState(server, trustDir);
  return state.status === 'valid' ? state.pin : null;
}

/** Atomic write of a whole pin (tmp + rename), so a crash never leaves a torn file that reads as no pin. */
function persistPin(pin: Pin, trustDir: string): boolean {
  try {
    fs.mkdirSync(trustDir, { recursive: true });
    const tmp = path.join(trustDir, `.${safeName(pin.server)}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(pin, null, 2) + '\n');
    fs.renameSync(tmp, pinPath(pin.server, trustDir));
    return true;
  } catch {
    // Callers in enforce mode must withhold operations when persistence fails.
    return false;
  }
}

/**
 * Pin a server's surface on first sight. `prompts` is included only when the
 * caller has actually seen a complete prompt listing — omitted means the prompt
 * channel is not yet approved and will be pinned by `pinPrompts` on its first
 * complete listing, never that the server has no prompts.
 */
export function writePin(server: string, tools: ToolShape[], trustDir: string, instructions?: string, prompts?: ToolShape[]): boolean {
  const pin: Pin = { server, approvedAt: new Date().toISOString(), tools, instructions: instructions ?? '', ...(prompts ? { prompts } : {}) };
  return persistPin(pin, trustDir);
}

/**
 * Attach a first-sight prompt surface to an EXISTING pin (one written before
 * prompts were covered, or before this server's prompts were first listed).
 * The tool surface, instructions and approval date are untouched: this is the
 * trust-on-first-use step for the prompt channel alone. Returns false when
 * there is no pin to attach to — the tool listing pins first, and carries the
 * prompts with it.
 */
export function pinPrompts(server: string, prompts: ToolShape[], trustDir: string): boolean {
  const pin = readPin(server, trustDir);
  if (!pin) return false;
  return persistPin({ ...pin, prompts }, trustDir);
}

export function forgetPin(server: string, trustDir: string): boolean {
  try {
    fs.unlinkSync(pinPath(server, trustDir));
    return true;
  } catch {
    return false;
  }
}

/**
 * The kinds of surface change that are a SECURITY concern — a tool the model
 * would now read differently than when it was approved, or one that appeared
 * unapproved. Only a `vanished` tool is reported without blocking: it is gone,
 * so there is nothing live to withhold. Everything else is blocked in enforce
 * mode, including a `renamed` tool: the new name is exposed and callable, and
 * "the same schema now reachable under a name I never approved" is exactly the
 * substitution a rug-pull uses. `annotations` blocking catches a readOnly→write
 * flip in place; the strict rename pairing in diffSurface (annotations must
 * match) keeps such a flip from hiding as a rename in the first place.
 */
const BLOCKING: ReadonlySet<SurfaceChange['kind']> = new Set(['appeared', 'renamed', 'schema', 'description', 'annotations']);

export interface TrustVerdict {
  /** Human-readable drift from the approved surface, most alarming first. */
  changes: SurfaceChange[];
  /** RAW upstream tool names to withhold in enforce mode (changed or unapproved). */
  blocked: Set<string>;
  /** The server's own `instructions` string drifted from what was approved. */
  instructionsChanged: boolean;
}

/**
 * Compare a live surface to the approved one. Pure. The blocked set holds the
 * name that is LIVE and callable now — for a rename that is the new name
 * (`c.to`), not the old one that no longer exists, so the withhold actually
 * lands on the tool the model would otherwise be handed. The optional
 * instructions arguments carry the server's own `instructions` channel through
 * the same check: the model reads it, so drift in it is a security event too.
 */
export function evaluateTrust(
  approved: ToolShape[],
  live: ToolShape[],
  approvedInstructions?: string,
  liveInstructions?: string,
): TrustVerdict {
  const changes = diffSurface(approved, live);
  const blocked = new Set<string>();
  for (const c of changes) {
    if (!BLOCKING.has(c.kind)) continue;
    blocked.add(c.kind === 'renamed' && c.to ? c.to : c.tool);
  }
  const instructionsChanged = (approvedInstructions ?? '') !== (liveInstructions ?? '');
  return { changes, blocked, instructionsChanged };
}
