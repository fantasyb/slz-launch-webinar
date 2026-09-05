/**
 * Read and parse a JSON request body with a hard byte cap.
 *
 * `await request.json()` buffers and parses the WHOLE body before any zod bound
 * runs, so the field-level `.max()` limits the routes cite as their DoS defence
 * cannot help — a client can POST gigabytes first. Next's App Router sets no body
 * limit, so on a self-hosted `next start` this is a real amplifier. Cap before
 * (and while) reading: content-length when present, and a running byte count for
 * chunked/spoofed requests (the same approach fetchJson.ts uses outbound).
 */
export class BodyTooLarge extends Error {
  constructor(readonly limit: number) {
    super(`request body exceeds ${limit} bytes`);
    this.name = 'BodyTooLarge';
  }
}

/** 1 MiB — a legitimate submission (20 evidence × 20k chars) is well under this. */
export const DEFAULT_MAX_BODY = 1 << 20;

export async function readJsonBody(request: Request, maxBytes = DEFAULT_MAX_BODY): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) throw new BodyTooLarge(maxBytes);

  const body = request.body;
  if (!body) {
    const text = await request.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new BodyTooLarge(maxBytes);
    return text.trim() === '' ? null : JSON.parse(text);
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* already closed */ }
        throw new BodyTooLarge(maxBytes);
      }
      chunks.push(value);
    }
  }
  const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
  return text.trim() === '' ? null : JSON.parse(text);
}
