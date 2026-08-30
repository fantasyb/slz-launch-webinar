/**
 * Cairn is read by agents, which makes it an instruction channel.
 *
 * A finding's `workaround` field literally tells an agent what to do next, and
 * `check.command` is a shell command an agent may run unattended. A corpus
 * that anyone can contribute to, consumed by machines that act on it, is a
 * supply chain — and pretending otherwise because the content is "just data"
 * is the same category of mistake the corpus exists to record.
 *
 * Two directions need guarding, and they are different problems:
 *
 *   INBOUND   Text arriving from the corpus that an agent might execute.
 *             Defended by pull-request review, and by flagging patterns that
 *             fetch-and-execute or exfiltrate so a reviewer cannot miss them.
 *
 *   OUTBOUND  Text leaving a private repository in a submission. Evidence is
 *             error output, and error output routinely carries internal
 *             hostnames, home directory paths, tokens in URLs, and proprietary
 *             source. This never leaves a machine automatically.
 */

export interface Flag {
  severity: 'block' | 'warn';
  pattern: string;
  reason: string;
  sample: string;
}

/** Fetch-and-execute, reverse shells, and quiet exfiltration. */
const DANGEROUS: Array<{ re: RegExp; pattern: string; reason: string; severity: 'block' | 'warn' }> = [
  {
    re: /\b(curl|wget|fetch)\b[^\n|]*\|\s*(ba)?sh\b/i,
    pattern: 'pipe-to-shell',
    reason: 'downloads and executes remote code in one step',
    severity: 'block',
  },
  {
    re: /\b(eval|exec)\s*\(?\s*\$\(/,
    pattern: 'eval-of-substitution',
    reason: 'evaluates the output of another command as code',
    severity: 'block',
  },
  {
    re: /base64\s+(-d|--decode)[^\n]*\|\s*(ba)?sh\b/i,
    pattern: 'obfuscated-execution',
    reason: 'decodes and executes hidden content',
    severity: 'block',
  },
  {
    re: /\b(nc|ncat|netcat)\b[^\n]*\s-e\b/i,
    pattern: 'reverse-shell',
    reason: 'binds a shell to a network connection',
    severity: 'block',
  },
  {
    re: /\brm\s+-rf?\s+(\/(?!tmp)|~|\$HOME)/,
    pattern: 'destructive-path',
    reason: 'recursive delete outside a temp directory',
    severity: 'block',
  },
  {
    re: /\b(cat|type)\b[^\n]*\b(\.env|id_rsa|credentials|\.npmrc|\.aws)\b/i,
    pattern: 'reads-credentials',
    reason: 'reads a file that commonly holds secrets',
    severity: 'block',
  },
  {
    re: /\b(curl|wget)\b[^\n]*\s(-d|--data|-F|-T|--upload-file)\b/i,
    pattern: 'uploads-data',
    reason: 'sends local data to a remote host',
    severity: 'warn',
  },
  {
    re: /\bsudo\b/,
    pattern: 'privilege-escalation',
    reason: 'requests elevated privileges',
    severity: 'warn',
  },
];

/**
 * Scan text an agent might execute or act on. Applied to every finding's
 * check command and workaround at lint time, so a hostile contribution has to
 * survive a reviewer who has been handed the reason to look.
 */
export function scanExecutable(text: string): Flag[] {
  return DANGEROUS.flatMap((d) => {
    const m = d.re.exec(text);
    return m
      ? [{ severity: d.severity, pattern: d.pattern, reason: d.reason, sample: m[0].slice(0, 120) }]
      : [];
  });
}

/** Things that should never leave a private repository in a submission. */
const SENSITIVE: Array<{ re: RegExp; pattern: string; reason: string }> = [
  { re: /\b(sk|pk|ghp|gho|ghs|xox[baprs])[-_][A-Za-z0-9_-]{16,}/, pattern: 'api-token', reason: 'looks like an API token' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, pattern: 'private-key', reason: 'a private key block' },
  { re: /\b[A-Za-z0-9._%+-]+@(?!example\.|test\.)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/, pattern: 'email', reason: 'an email address' },
  { re: /\b(?:password|passwd|secret|api[_-]?key|authorization)\s*[:=]\s*\S{6,}/i, pattern: 'credential-assignment', reason: 'a credential assignment' },
  { re: /\/(?:home|Users)\/(?!user\b|runner\b)[A-Za-z0-9._-]+/, pattern: 'home-path', reason: 'a home directory naming a real user' },
  { re: /\bhttps?:\/\/(?![^\s]*(?:example\.com|localhost))[a-z0-9-]+\.(?:internal|corp|local|intranet)\b/i, pattern: 'internal-host', reason: 'an internal hostname' },
  { re: /\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/, pattern: 'private-ip', reason: 'a private network address' },
  { re: /\b[A-Za-z0-9+/]{40,}={0,2}\b/, pattern: 'opaque-blob', reason: 'a long opaque string that may be encoded data' },
];

export function scanSensitive(text: string): Flag[] {
  return SENSITIVE.flatMap((d) => {
    const m = d.re.exec(text);
    return m ? [{ severity: 'warn' as const, pattern: d.pattern, reason: d.reason, sample: m[0].slice(0, 60) }] : [];
  });
}

/** Everything in a draft finding that would be published, concatenated. */
export function draftSurface(d: Record<string, unknown>): string {
  const parts: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'string') parts.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(d);
  return parts.join('\n');
}
