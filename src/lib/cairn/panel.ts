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

function buildCall(m: PanelMember, apiKey: string, prompt: string, maxTokens: number): ProviderCall {
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
          system: SYSTEM_PROMPT,
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
          max_completion_tokens: maxTokens,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: prompt },
          ],
        },
        extract: (j) =>
          (j as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message
            ?.content ?? '',
      };

    case 'google':
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${m.model}:generateContent?key=${apiKey}`,
        headers: { 'content-type': 'application/json' },
        body: {
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
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
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error(`no JSON object in response: ${text.slice(0, 200)}`);
  return ForecastSchema.parse(JSON.parse(cleaned.slice(start, end + 1)));
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
  const apiKey = process.env[m.apiKeyEnv];
  if (!apiKey) {
    return { member: m, findingId: f.id, error: `${m.apiKeyEnv} is not set` };
  }
  const call = buildCall(m, apiKey, buildPrompt(f), cfg.maxTokens);

  try {
    const res = await fetch(call.url, {
      method: 'POST',
      headers: call.headers,
      body: JSON.stringify(call.body),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    if (!res.ok) {
      return { member: m, findingId: f.id, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}` };
    }
    return { member: m, findingId: f.id, forecast: parseForecast(call.extract(await res.json())) };
  } catch (e) {
    return { member: m, findingId: f.id, error: (e as Error).message };
  }
}
