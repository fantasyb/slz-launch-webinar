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

export function writePin(server: string, tools: ToolShape[], trustDir: string): boolean {
  try {
    fs.mkdirSync(trustDir, { recursive: true });
    const pin: Pin = { server, approvedAt: new Date().toISOString(), tools };
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
 * unapproved. A pure rename (same schema and description) and a tool that
 * vanished are reported but not blocked: neither hands the model a changed
 * instruction or a new capability, so withholding them would be noise, not
 * safety. `annotations` IS blocking: a readOnly→write flip is a privilege change.
 */
const BLOCKING: ReadonlySet<SurfaceChange['kind']> = new Set(['appeared', 'schema', 'description', 'annotations']);

export interface TrustVerdict {
  /** Human-readable drift from the approved surface, most alarming first. */
  changes: SurfaceChange[];
  /** RAW upstream tool names to withhold in enforce mode (changed or unapproved). */
  blocked: Set<string>;
}

/** Compare a live surface to the approved one. Pure. */
export function evaluateTrust(approved: ToolShape[], live: ToolShape[]): TrustVerdict {
  const changes = diffSurface(approved, live);
  const blocked = new Set<string>();
  for (const c of changes) if (BLOCKING.has(c.kind)) blocked.add(c.tool);
  return { changes, blocked };
}
