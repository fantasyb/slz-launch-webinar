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

/**
 * Fetch-and-execute, reverse shells, and quiet exfiltration.
 *
 * READ THIS BEFORE RELYING ON IT. These patterns are a review aid, not a
 * security boundary. Pattern matching on shell text is trivially evadable and
 * always will be: `curl x | sh` is caught, `curl x > /tmp/a && sh /tmp/a`,
 * `bash <(curl x)` and `python -c 'exec(urlopen(...).read())'` are not, and no
 * finite list closes that. Measured on this list, five of eight hand-written
 * evasions pass.
 *
 * What it is for: making a careless or accidental contribution obvious, and
 * handing a reviewer a reason to look. What actually defends the corpus is
 * that every finding arrives by pull request and a person merges it. If that
 * review lapses, this list will not save anyone, and treating it as though it
 * would is the more dangerous error.
 */
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
  { re: /\bhttps?:\/\/(?![^\s]*(?:example\.com|localhost))(?:[a-z0-9-]+\.)*[a-z0-9-]+\.(?:internal|corp|local|intranet|lan)\b/i, pattern: 'internal-host', reason: 'an internal hostname' },
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

export interface Redaction {
  pattern: string;
  original: string;
  replacement: string;
}

/**
 * Strip, do not warn.
 *
 * A flow that hands a person eight warnings per draft and asks them to
 * adjudicate each one guarantees nobody contributes twice. Redaction has to be
 * automatic and fail closed, so the default path is safe and the human decision
 * shrinks to a single yes at the moment of publishing.
 *
 * Ordered deliberately: key blocks and tokens first, so that a later, broader
 * rule cannot partially rewrite a secret and leave a recognisable remnant.
 *
 * WHAT THIS CANNOT DO. It catches mechanical leaks — credentials, addresses,
 * paths, opaque blobs. It cannot tell that a stack frame quotes proprietary
 * source, that a table name reveals a product, or that a directory is a
 * customer. Those are semantic and need a person. Redaction shrinks the
 * judgement call; it does not remove it.
 */
const REDACTIONS: Array<{ re: RegExp; pattern: string; to: string }> = [
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, pattern: 'private-key', to: '<redacted:private-key>' },
  { re: /\b(?:sk|pk|ghp|gho|ghs|ghu|xox[baprs])[-_][A-Za-z0-9_-]{16,}/g, pattern: 'api-token', to: '<redacted:token>' },
  { re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, pattern: 'auth-header', to: '$1 <redacted:credential>' },
  { re: /((?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*)("|')?[^\s"',}]{6,}\2?/gi, pattern: 'credential-assignment', to: '$1<redacted:credential>' },
  { re: /\b[A-Za-z0-9._%+-]+@(?!example\.|test\.)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, pattern: 'email', to: '<redacted:email>' },
  { re: /\b(https?:\/\/)(?:[a-z0-9-]+\.)*[a-z0-9-]+(\.(?:internal|corp|local|intranet|lan))\b/gi, pattern: 'internal-host', to: '$1<redacted:host>$2' },
  { re: /\/(home|Users)\/(?!user\b|runner\b|root\b)[A-Za-z0-9._-]+/g, pattern: 'home-path', to: '/$1/<redacted:user>' },
  { re: /\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\.?\d{0,3}\b/g, pattern: 'private-ip', to: '<redacted:private-ip>' },
  { re: /\b[A-Za-z0-9+/]{60,}={0,2}\b/g, pattern: 'opaque-blob', to: '<redacted:blob>' },
];

export function redact(text: string): { text: string; redactions: Redaction[] } {
  const redactions: Redaction[] = [];
  let out = text;
  for (const r of REDACTIONS) {
    out = out.replace(r.re, (...args: unknown[]) => {
      const match = args[0] as string;
      const replacement = (r.to as string).replace(/\$(\d)/g, (_, d: string) => (args[Number(d)] as string) ?? '');
      redactions.push({ pattern: r.pattern, original: match.slice(0, 60), replacement });
      return replacement;
    });
  }
  return { text: out, redactions };
}

/** Redact every string in a nested structure, in place-equivalent form. */
export function redactDeep<T>(value: T): { value: T; redactions: Redaction[] } {
  const redactions: Redaction[] = [];
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const r = redact(v);
      redactions.push(...r.redactions);
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return { value: walk(value) as T, redactions };
}
