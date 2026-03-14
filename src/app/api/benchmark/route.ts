import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { SCENARIOS, TOKEN_COSTS } from '@/lib/benchmark-data';

const anthropic = new Anthropic();

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

interface BenchmarkResult {
  scenarioId: string;
  scenarioName: string;
  generalist: AgentResult;
  specialist: AgentResult;
  orchestrator: AgentResult;
  winner: string;
  costSavings: number;
  qualityGain: number;
}

async function callClaude(
  systemPrompt: string,
  userMessage: string,
  model: string = 'claude-haiku-4-5-20251001'
): Promise<{ output: string; inputTokens: number; outputTokens: number; latencyMs: number }> {
  const start = Date.now();
  const response = await anthropic.messages.create({
    model,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });
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
}

function cleanJsonOutput(text: string): string {
  // Strip markdown code fences if present
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  return cleaned.trim();
}

async function runAgent(
  type: 'generalist' | 'specialist' | 'orchestrator',
  scenario: typeof SCENARIOS[number]
): Promise<AgentResult> {
  const runs: RunResult[] = [];

  for (const testCase of scenario.testCases) {
    let result: RunResult;

    if (type === 'orchestrator') {
      // Step 1: Orchestrator routes the task
      const routingResult = await callClaude(scenario.orchestratorPrompt, testCase.input);

      // Step 2: Specialist executes (we already know it should route to this scenario's specialist)
      const specialistResult = await callClaude(scenario.specialistPrompt, testCase.input);

      const totalInputTokens = routingResult.inputTokens + specialistResult.inputTokens;
      const totalOutputTokens = routingResult.outputTokens + specialistResult.outputTokens;
      const totalLatency = routingResult.latencyMs + specialistResult.latencyMs;
      const cost = (totalInputTokens * TOKEN_COSTS.input) + (totalOutputTokens * TOKEN_COSTS.output);

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
      const callResult = await callClaude(prompt, testCase.input);
      const cost = (callResult.inputTokens * TOKEN_COSTS.input) + (callResult.outputTokens * TOKEN_COSTS.output);

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
    const { scenarioIds } = body as { scenarioIds?: string[] };

    const selectedScenarios = scenarioIds
      ? SCENARIOS.filter(s => scenarioIds.includes(s.id))
      : SCENARIOS;

    if (selectedScenarios.length === 0) {
      return NextResponse.json({ error: 'No valid scenarios selected' }, { status: 400 });
    }

    const results: BenchmarkResult[] = [];

    for (const scenario of selectedScenarios) {
      // Run all three agent types in parallel per scenario
      const [generalist, specialist, orchestrator] = await Promise.all([
        runAgent('generalist', scenario),
        runAgent('specialist', scenario),
        runAgent('orchestrator', scenario),
      ]);

      // Determine winner by score-adjusted cost efficiency
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

      results.push({
        scenarioId: scenario.id,
        scenarioName: scenario.name,
        generalist,
        specialist,
        orchestrator,
        winner: best.agent,
        costSavings,
        qualityGain,
      });
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
    };

    return NextResponse.json({ results, summary });
  } catch (error) {
    console.error('Benchmark error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: `Benchmark failed: ${message}` }, { status: 500 });
  }
}

// GET returns available scenarios without running them
export async function GET() {
  return NextResponse.json({
    scenarios: SCENARIOS.map(s => ({
      id: s.id,
      name: s.name,
      description: s.description,
      testCaseCount: s.testCases.length,
    })),
  });
}
