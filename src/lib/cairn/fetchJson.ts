/**
 * Fetch JSON from an untrusted host with the two bounds a bare `fetch` lacks.
 *
 * The signature and schema gates elsewhere decide what bad *content* can do.
 * They say nothing about a server that accepts the connection and then never
 * finishes: `await fetch(...)` followed by `await res.json()` will wait
 * forever, and buffers however many gigabytes arrive before any validation
 * runs. Both matter here because these calls sit in `cairn:federate`, which is
 * the thing people put on a cron.
 *
 * Redirects are refused rather than followed. install.ts records a
 * trust-on-first-use pin against the host in the URL it was given, so a
 * silently followed redirect would file the key under a host that never
 * served it.
 */
export const MAX_BYTES = 8 * 1024 * 1024;
export const TIMEOUT_MS = 15_000;

export async function fetchJson(
  url: string,
  opts: { timeoutMs?: number; maxBytes?: number; allowRedirect?: boolean } = {},
): Promise<unknown> {
  const maxBytes = opts.maxBytes ?? MAX_BYTES;
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    redirect: opts.allowRedirect ? 'follow' : 'error',
    signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);

  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`${url} -> ${declared} bytes exceeds the ${maxBytes} byte cap`);
  }

  // content-length is a hint, not a promise: enforce the cap while reading.
  const reader = res.body?.getReader();
  if (!reader) throw new Error(`${url} -> empty response body`);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`${url} -> response exceeds the ${maxBytes} byte cap`);
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
