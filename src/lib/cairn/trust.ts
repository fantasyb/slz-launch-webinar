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
import { diffSurface, type ToolShape, type SurfaceChange } from './toolsurface';

export type TrustMode = 'off' | 'monitor' | 'enforce';

export function trustMode(): TrustMode {
  const m = (process.env.CAIRN_TRUST_MODE ?? 'off').toLowerCase();
  return m === 'monitor' || m === 'enforce' ? m : 'off';
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
}

const safeName = (s: string) => s.replace(/[^A-Za-z0-9_.-]+/g, '_') || 'server';
export function pinPath(server: string, trustDir: string): string {
  return path.join(trustDir, `${safeName(server)}.json`);
}

export function readPin(server: string, trustDir: string): Pin | null {
  try {
    const p = JSON.parse(fs.readFileSync(pinPath(server, trustDir), 'utf8')) as Pin;
    return p && Array.isArray(p.tools) ? p : null;
  } catch {
    return null;
  }
}

export function writePin(server: string, tools: ToolShape[], trustDir: string, instructions?: string): boolean {
  try {
    fs.mkdirSync(trustDir, { recursive: true });
    const pin: Pin = { server, approvedAt: new Date().toISOString(), tools, instructions: instructions ?? '' };
    const tmp = path.join(trustDir, `.${safeName(server)}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(pin, null, 2) + '\n');
    fs.renameSync(tmp, pinPath(server, trustDir));
    return true;
  } catch {
    // Best-effort: a pin that cannot be written just means no enforcement this
    // run, never a broken gateway.
    return false;
  }
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
