import { z } from 'zod';
import type { Finding } from './schema';

/**
 * The panel: several frontier models forecasting the same sealed claims.
 *
 * Every provider is called the same way — raw HTTP, same prompt, same
 * parsing, same retry policy. Using one vendor's official SDK and raw HTTP
 * for the rest would bake asymmetry into the arbiter (different default
 * timeouts, retries and implicit parameters), and the whole value of this
 * ledger is that no participant got favourable treatment.
 *
 * Structured output is requested in-prompt rather than through any provider's
 * native JSON mode, for the same reason: native modes differ in how hard they
 * constrain the model, which is not a difference you want inside your
 * measurement.
 */

export const ProviderSchema = z.enum(['anthropic', 'openai', 'google', 'xai']);
export type Provider = z.infer<typeof ProviderSchema>;

export const PanelMemberSchema = z.object({
  /** Stable identifier used as `by` in the ledger. Keep it stable over time. */
  label: z.string().min(1),
  provider: ProviderSchema,
  /** Exact model id. Verify against the provider's docs before a real run. */
  model: z.string().min(1),
  apiKeyEnv: z.string().min(1),
});
export type PanelMember = z.infer<typeof PanelMemberSchema>;

export const PanelConfigSchema = z.object({
  members: z.array(PanelMemberSchema),
  maxTokens: z.number().int().positive().default(1200),
  timeoutMs: z.number().int().positive().default(120_000),
});
export type PanelConfig = z.infer<typeof PanelConfigSchema>;

export const ForecastSchema = z.object({
  priorConfirmed: z.number().min(0).max(1),
  reasoning: z.string().min(1),
});
export type Forecast = z.infer<typeof ForecastSchema>;

export const SYSTEM_PROMPT = `You are forecasting whether a specific, falsifiable claim about software behaviour will be CONFIRMED when a verification command is executed.

You will be shown the claim and the exact command that adjudicates it. You will NOT be shown any evidence, prior results, or other forecasts. Reason from what you know.

Respond with ONLY a JSON object, no prose before or after, no code fences:

{"priorConfirmed": <number between 0 and 1>, "reasoning": "<why, in 2-4 sentences>"}

priorConfirmed is your probability that running the command produces the CONFIRMED condition rather than the REFUTED condition.

Be calibrated, not confident. If you are genuinely unsure, say so with a number near 0.5. A well-calibrated 0.6 is worth more than an overconfident 0.95.`;

/**
 * The blinded view. Deliberately excludes evidence, observations, mechanism
 * and workaround — everything that would leak the answer.
 */
export function buildPrompt(f: Finding): string {
  return [
    `SUBJECT: ${f.subject.name} (${f.subject.ecosystem}), versions ${f.subject.versions}`,
    `SCOPE: ${f.scope}${f.appliesTo ? ` — ${f.appliesTo}` : ''}`,
    '',
    `CLAIM:`,
    f.claim,
    '',
    `VERIFICATION COMMAND:`,
    f.check.command,
    '',
    `CONFIRMED IF: ${f.check.confirmedIf}`,
    `REFUTED IF:   ${f.check.refutedIf}`,
  ].join('\n');
}

interface ProviderCall {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  extract: (json: unknown) => string;
}

export function buildCall(
  m: PanelMember,
  apiKey: string,
  prompt: string,
  maxTokens: number,
  system: string = SYSTEM_PROMPT,
): ProviderCall {
  switch (m.provider) {
    case 'anthropic':
      return {
        url: 'https://api.anthropic.com/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: {
          model: m.model,
          max_tokens: maxTokens,
          system,
          messages: [{ role: 'user', content: prompt }],
        },
        extract: (j) => {
          const blocks = (j as { content?: Array<{ type: string; text?: string }> }).content ?? [];
          return blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
        },
      };

    case 'openai':
    case 'xai':
      return {
        url:
          m.provider === 'openai'
            ? 'https://api.openai.com/v1/chat/completions'
            : 'https://api.x.ai/v1/chat/completions',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: {
          model: m.model,
          // OpenAI renamed this for reasoning models; xAI's chat-completions
          // API documents the original name. Sending the wrong one is either
          // ignored (no output cap) or a 400 on every call.
          ...(m.provider === 'openai'
            ? { max_completion_tokens: maxTokens }
            : { max_tokens: maxTokens }),
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
          ],
        },
        extract: (j) =>
          (j as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message
            ?.content ?? '',
      };

    case 'google':
      return {
        // Key in a header, never the query string: a URL ends up in proxy logs,
        // error text and stack traces, and this environment routes through a
        // logging proxy.
        url: `https://generativelanguage.googleapis.com/v1beta/models/${m.model}:generateContent`,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: maxTokens },
        },
        extract: (j) =>
          (j as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> })
            .candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '',
      };
  }
}

/** Models wrap JSON in prose or fences despite instructions. Recover it. */
export function parseForecast(text: string): Forecast {
  // Parse first, recover second. Running the fence strip over the whole reply
  // deleted backticks INSIDE string values, so a valid fence-free forecast
  // whose reasoning mentioned ```json was accepted with its reasoning silently
  // altered -- and research/scripts/panel.ts then hashed the altered text into the
  // commitment. A wrongly-accepted modified value is worse than a rejection.
  const trimmed = text.trim();
  try {
    return ForecastSchema.parse(JSON.parse(trimmed));
  } catch {
    /* not bare JSON; fall through to fence and prose recovery */
  }
  const cleaned = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error(`no JSON object in response: ${text.slice(0, 200)}`);
  return ForecastSchema.parse(JSON.parse(cleaned.slice(start, end + 1)));
}

/**
 * Node's fetch reports transport failures as a bare "fetch failed" with the
 * real reason on `cause`, and drops a timeout's error name. Flattening to
 * `.message` made every manifest entry undiagnosable.
 */
/** Max bytes accepted from a provider before the read is abandoned. */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * Read a response body with a size bound.
 *
 * `await res.json()` buffers whatever arrives. The timeout bounds how long a
 * provider may take; nothing bounded how much it could send, so a provider or
 * middlebox streaming steadily inside the timeout window could make the
 * process buffer without limit. fetchJson already did this for federation;
 * the panel transport did not.
 */
async function readBounded(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error(`response exceeded ${MAX_RESPONSE_BYTES} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function describeError(e: unknown): string {
  const err = e as { name?: string; message?: string; cause?: unknown };
  const cause = err?.cause ? ` (${String((err.cause as Error)?.message ?? err.cause)})` : '';
  const name = err?.name && err.name !== 'Error' ? `${err.name}: ` : '';
  return `${name}${err?.message ?? String(e)}${cause}`;
}

/**
 * One request to one provider, returning raw text.
 *
 * Shared by forecasting and adversarial review so that both go through the
 * identical transport — same timeouts, same body bound, same parsing. A
 * reviewer called differently from a forecaster is a reviewer whose results
 * cannot be compared with theirs.
 *
 * There are deliberately no retries. A retry would have to be recorded, or the
 * manifest would under-report how many attempts a forecast took; until that is
 * designed, an error is an error. The docstring here previously claimed "same
 * retries", which was never true of any code path.
 */
export async function ask(
  m: PanelMember,
  system: string,
  prompt: string,
  cfg: PanelConfig,
): Promise<{ text?: string; error?: string }> {
  const apiKey = process.env[m.apiKeyEnv];
  if (!apiKey) return { error: `${m.apiKeyEnv} is not set` };
  const call = buildCall(m, apiKey, prompt, cfg.maxTokens, system);
  try {
    const res = await fetch(call.url, {
      method: 'POST',
      headers: call.headers,
      body: JSON.stringify(call.body),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    if (!res.ok) return { error: `HTTP ${res.status}: ${(await readBounded(res)).slice(0, 300)}` };
    return { text: call.extract(JSON.parse(await readBounded(res))) };
  } catch (e) {
    return { error: describeError(e) };
  }
}

export interface SolicitResult {
  member: PanelMember;
  findingId: string;
  forecast?: Forecast;
  error?: string;
}

/**
 * One forecast. Errors are returned, never thrown: a failed solicitation must
 * still appear in the manifest, otherwise the operator could quietly drop
 * unfavourable results and nobody could tell.
 */
export async function solicit(
  m: PanelMember,
  f: Finding,
  cfg: PanelConfig,
): Promise<SolicitResult> {
  // Through ask(), not a second copy of the transport. This function used to
  // reimplement the fetch, so the size bound, the error-cause handling and the
  // key placement all had to be fixed twice -- and `ask`'s own docstring says
  // the whole point is that a reviewer and a forecaster go through identical
  // transport. Two copies is how that stops being true without anyone editing
  // the sentence.
  const res = await ask(m, SYSTEM_PROMPT, buildPrompt(f), cfg);
  if (res.error || !res.text) {
    return { member: m, findingId: f.id, error: res.error ?? 'empty response' };
  }
  try {
    return { member: m, findingId: f.id, forecast: parseForecast(res.text) };
  } catch (e) {
    return { member: m, findingId: f.id, error: describeError(e) };
  }
}
