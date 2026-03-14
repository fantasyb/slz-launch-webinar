import { NextRequest } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { SCENARIOS, TOKEN_COSTS } from '@/lib/benchmark-data';

const anthropic = new Anthropic();

const AVAILABLE_MODELS = [
  { id: 'claude-haiku-4-5-20251001', label: 'Claude 4.5 Haiku', inputCostPer1M: 0.80, outputCostPer1M: 4.00 },
  { id: 'claude-sonnet-4-6', label: 'Claude 4.6 Sonnet', inputCostPer1M: 3.00, outputCostPer1M: 15.00 },
];

interface RunResult {
  testCaseId: string;
  output: string;
  score: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  costUsd: number;
}

interface AgentResult {
  agent: 'generalist' | 'specialist' | 'orchestrator';
  runs: RunResult[];
  avgScore: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalLatencyMs: number;
  totalCostUsd: number;
  avgLatencyMs: number;
}

async function callClaudeWithRetry(
  systemPrompt: string,
  userMessage: string,
  model: string = 'claude-haiku-4-5-20251001',
  maxRetries: number = 3,
  timeoutMs: number = 30000,
): Promise<{ output: string; inputTokens: number; outputTokens: number; latencyMs: number }> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      const start = Date.now();
      const response = await anthropic.messages.create(
        {
          model,
          max_tokens: 1024,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
        },
        { signal: controller.signal },
      );
      clearTimeout(timeout);
      const latencyMs = Date.now() - start;

      const output = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map(block => block.text)
        .join('');

      return {
        output: cleanJsonOutput(output),
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        latencyMs,
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        const backoff = Math.pow(2, attempt) * 1000;
        await new Promise(resolve => setTimeout(resolve, backoff));
      }
    }
  }

  throw lastError || new Error('callClaude failed after retries');
}

function cleanJsonOutput(text: string): string {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  return cleaned.trim();
}

function getTokenCosts(modelId: string) {
  const model = AVAILABLE_MODELS.find(m => m.id === modelId);
  if (model) {
    return { input: model.inputCostPer1M / 1_000_000, output: model.outputCostPer1M / 1_000_000 };
  }
  return { input: TOKEN_COSTS.input, output: TOKEN_COSTS.output };
}

async function runAgent(
  type: 'generalist' | 'specialist' | 'orchestrator',
  scenario: typeof SCENARIOS[number],
  modelId: string,
  onProgress: (msg: string) => void,
): Promise<AgentResult> {
  const runs: RunResult[] = [];
  const costs = getTokenCosts(modelId);

  for (let i = 0; i < scenario.testCases.length; i++) {
    const testCase = scenario.testCases[i];
    onProgress(`${type}:${scenario.id}:${i + 1}/${scenario.testCases.length}`);

    let result: RunResult;

    if (type === 'orchestrator') {
      const routingResult = await callClaudeWithRetry(scenario.orchestratorPrompt, testCase.input, modelId);
      const specialistResult = await callClaudeWithRetry(scenario.specialistPrompt, testCase.input, modelId);

      const totalInputTokens = routingResult.inputTokens + specialistResult.inputTokens;
      const totalOutputTokens = routingResult.outputTokens + specialistResult.outputTokens;
      const totalLatency = routingResult.latencyMs + specialistResult.latencyMs;
      const cost = (totalInputTokens * costs.input) + (totalOutputTokens * costs.output);

      result = {
        testCaseId: testCase.id,
        output: specialistResult.output,
        score: scenario.scoreOutput(specialistResult.output, testCase.expectedOutput),
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        latencyMs: totalLatency,
        costUsd: cost,
      };
    } else {
      const prompt = type === 'generalist' ? scenario.generalistPrompt : scenario.specialistPrompt;
      const callResult = await callClaudeWithRetry(prompt, testCase.input, modelId);
      const cost = (callResult.inputTokens * costs.input) + (callResult.outputTokens * costs.output);

      result = {
        testCaseId: testCase.id,
        output: callResult.output,
        score: scenario.scoreOutput(callResult.output, testCase.expectedOutput),
        inputTokens: callResult.inputTokens,
        outputTokens: callResult.outputTokens,
        latencyMs: callResult.latencyMs,
        costUsd: cost,
      };
    }

    runs.push(result);
  }

  const totalInputTokens = runs.reduce((sum, r) => sum + r.inputTokens, 0);
  const totalOutputTokens = runs.reduce((sum, r) => sum + r.outputTokens, 0);
  const totalLatencyMs = runs.reduce((sum, r) => sum + r.latencyMs, 0);
  const totalCostUsd = runs.reduce((sum, r) => sum + r.costUsd, 0);
  const avgScore = runs.reduce((sum, r) => sum + r.score, 0) / runs.length;

  return {
    agent: type,
    runs,
    avgScore,
    totalInputTokens,
    totalOutputTokens,
    totalLatencyMs,
    totalCostUsd,
    avgLatencyMs: totalLatencyMs / runs.length,
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { scenarioIds, model: modelId } = body as { scenarioIds?: string[]; model?: string };

    const selectedModel = modelId && AVAILABLE_MODELS.find(m => m.id === modelId) ? modelId : 'claude-haiku-4-5-20251001';

    const selectedScenarios = scenarioIds
      ? SCENARIOS.filter(s => scenarioIds.includes(s.id))
      : SCENARIOS;

    if (selectedScenarios.length === 0) {
      return new Response(JSON.stringify({ error: 'No valid scenarios selected' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Use SSE for streaming progress
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (event: string, data: unknown) => {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };

        try {
          const totalCalls = selectedScenarios.reduce((sum, s) => {
            // generalist + specialist + orchestrator (2 calls each)
            return sum + s.testCases.length * 4;
          }, 0);
          let completedCalls = 0;

          send('start', { totalScenarios: selectedScenarios.length, totalCalls, model: selectedModel });

          const results = [];

          for (const scenario of selectedScenarios) {
            send('scenario_start', { scenarioId: scenario.id, scenarioName: scenario.name });

            const onProgress = (msg: string) => {
              completedCalls++;
              send('progress', { message: msg, completed: completedCalls, total: totalCalls });
            };

            // Run all three agent types in parallel per scenario
            const [generalist, specialist, orchestrator] = await Promise.all([
              runAgent('generalist', scenario, selectedModel, onProgress),
              runAgent('specialist', scenario, selectedModel, onProgress),
              runAgent('orchestrator', scenario, selectedModel, onProgress),
            ]);

            const agents = [generalist, specialist, orchestrator];
            const best = agents.reduce((a, b) => {
              const aEfficiency = a.avgScore / Math.max(a.totalCostUsd, 0.000001);
              const bEfficiency = b.avgScore / Math.max(b.totalCostUsd, 0.000001);
              return aEfficiency > bEfficiency ? a : b;
            });

            const costSavings = generalist.totalCostUsd > 0
              ? ((generalist.totalCostUsd - specialist.totalCostUsd) / generalist.totalCostUsd) * 100
              : 0;

            const qualityGain = generalist.avgScore > 0
              ? ((specialist.avgScore - generalist.avgScore) / generalist.avgScore) * 100
              : 0;

            const scenarioResult = {
              scenarioId: scenario.id,
              scenarioName: scenario.name,
              generalist,
              specialist,
              orchestrator,
              winner: best.agent,
              costSavings,
              qualityGain,
            };

            results.push(scenarioResult);
            send('scenario_complete', scenarioResult);
          }

          // Compute aggregate summary
          const summary = {
            totalScenarios: results.length,
            totalTestCases: results.reduce((sum, r) => sum + r.generalist.runs.length, 0),
            avgGeneralistScore: results.reduce((sum, r) => sum + r.generalist.avgScore, 0) / results.length,
            avgSpecialistScore: results.reduce((sum, r) => sum + r.specialist.avgScore, 0) / results.length,
            avgOrchestratorScore: results.reduce((sum, r) => sum + r.orchestrator.avgScore, 0) / results.length,
            totalGeneralistCost: results.reduce((sum, r) => sum + r.generalist.totalCostUsd, 0),
            totalSpecialistCost: results.reduce((sum, r) => sum + r.specialist.totalCostUsd, 0),
            totalOrchestratorCost: results.reduce((sum, r) => sum + r.orchestrator.totalCostUsd, 0),
            avgCostSavings: results.reduce((sum, r) => sum + r.costSavings, 0) / results.length,
            avgQualityGain: results.reduce((sum, r) => sum + r.qualityGain, 0) / results.length,
            model: selectedModel,
          };

          send('complete', { results, summary });
          controller.close();
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          send('error', { error: `Benchmark failed: ${message}` });
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  } catch (error) {
    console.error('Benchmark error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ error: `Benchmark failed: ${message}` }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// GET returns available scenarios and models
export async function GET() {
  return new Response(JSON.stringify({
    scenarios: SCENARIOS.map(s => ({
      id: s.id,
      name: s.name,
      description: s.description,
      testCaseCount: s.testCases.length,
    })),
    models: AVAILABLE_MODELS,
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
