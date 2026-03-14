'use client';

import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Play,
  Loader2,
  Trophy,
  DollarSign,
  Zap,
  Target,
  BarChart3,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Clock,
  ArrowRight,
  TrendingUp,
  TrendingDown,
  Save,
  Trash2,
  History,
  Cpu,
} from 'lucide-react';

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

interface Summary {
  totalScenarios: number;
  totalTestCases: number;
  avgGeneralistScore: number;
  avgSpecialistScore: number;
  avgOrchestratorScore: number;
  totalGeneralistCost: number;
  totalSpecialistCost: number;
  totalOrchestratorCost: number;
  avgCostSavings: number;
  avgQualityGain: number;
  model?: string;
}

interface Scenario {
  id: string;
  name: string;
  description: string;
  testCaseCount: number;
}

interface ModelOption {
  id: string;
  label: string;
  inputCostPer1M: number;
  outputCostPer1M: number;
}

interface SavedRun {
  id: string;
  timestamp: string;
  model: string;
  results: BenchmarkResult[];
  summary: Summary;
}

const STORAGE_KEY = 'agentnet_benchmark_runs';

function loadSavedRuns(): SavedRun[] {
  if (typeof window === 'undefined') return [];
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

function saveRun(run: SavedRun) {
  const runs = loadSavedRuns();
  runs.unshift(run);
  // Keep last 10 runs
  if (runs.length > 10) runs.length = 10;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(runs));
}

function deleteRun(id: string) {
  const runs = loadSavedRuns().filter(r => r.id !== id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(runs));
}

const AGENT_COLORS = {
  generalist: { bg: 'bg-zinc-700', text: 'text-zinc-300', border: 'border-zinc-600', accent: '#71717a' },
  specialist: { bg: 'bg-indigo-600', text: 'text-indigo-300', border: 'border-indigo-500', accent: '#818cf8' },
  orchestrator: { bg: 'bg-emerald-600', text: 'text-emerald-300', border: 'border-emerald-500', accent: '#34d399' },
};

function ScoreBar({ score, color, label }: { score: number; color: string; label: string }) {
  const pct = Math.round(score * 100);
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-zinc-500 w-24 shrink-0">{label}</span>
      <div className="flex-1 h-6 bg-zinc-800 rounded-full overflow-hidden relative">
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.8, ease: 'easeOut' }}
          className="h-full rounded-full"
          style={{ backgroundColor: color }}
        />
        <span className="absolute inset-0 flex items-center justify-center text-xs font-mono font-bold text-white">
          {pct}%
        </span>
      </div>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, subValue, trend }: {
  icon: typeof Trophy;
  label: string;
  value: string;
  subValue?: string;
  trend?: 'up' | 'down' | 'neutral';
}) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
      <div className="flex items-center gap-2 mb-2">
        <Icon size={14} className="text-zinc-500" />
        <span className="text-xs text-zinc-500 uppercase tracking-wider">{label}</span>
      </div>
      <div className="flex items-end gap-2">
        <span className="text-2xl font-bold text-zinc-100">{value}</span>
        {subValue && (
          <span className={`text-xs mb-1 flex items-center gap-1 ${
            trend === 'up' ? 'text-emerald-400' : trend === 'down' ? 'text-red-400' : 'text-zinc-500'
          }`}>
            {trend === 'up' && <TrendingUp size={12} />}
            {trend === 'down' && <TrendingDown size={12} />}
            {subValue}
          </span>
        )}
      </div>
    </div>
  );
}

function TestCaseDetail({ run, agentType }: { run: RunResult; agentType: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border border-zinc-800 rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-2.5 bg-zinc-900/50 hover:bg-zinc-900 transition-colors"
      >
        <div className="flex items-center gap-3">
          {expanded ? <ChevronDown size={14} className="text-zinc-500" /> : <ChevronRight size={14} className="text-zinc-500" />}
          <span className="text-xs font-mono text-zinc-400">{run.testCaseId}</span>
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
            run.score >= 0.8 ? 'bg-emerald-500/10 text-emerald-400' :
            run.score >= 0.5 ? 'bg-yellow-500/10 text-yellow-400' :
            'bg-red-500/10 text-red-400'
          }`}>
            {Math.round(run.score * 100)}%
          </span>
        </div>
        <div className="flex items-center gap-4 text-xs text-zinc-500">
          <span>{run.inputTokens + run.outputTokens} tokens</span>
          <span>{run.latencyMs}ms</span>
          <span>${run.costUsd.toFixed(6)}</span>
        </div>
      </button>
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0 }}
            animate={{ height: 'auto' }}
            exit={{ height: 0 }}
            className="overflow-hidden"
          >
            <div className="px-4 py-3 bg-zinc-950 border-t border-zinc-800">
              <div className="text-xs text-zinc-500 mb-1 uppercase tracking-wider">
                {agentType} Output
              </div>
              <pre className="text-xs text-zinc-300 font-mono whitespace-pre-wrap bg-zinc-900 rounded p-3 max-h-60 overflow-auto">
                {(() => {
                  try {
                    return JSON.stringify(JSON.parse(run.output), null, 2);
                  } catch {
                    return run.output;
                  }
                })()}
              </pre>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ScenarioCard({ result }: { result: BenchmarkResult }) {
  const [showDetails, setShowDetails] = useState(false);
  const agents: Array<{ key: 'generalist' | 'specialist' | 'orchestrator'; label: string }> = [
    { key: 'generalist', label: 'Generalist' },
    { key: 'specialist', label: 'Specialist' },
    { key: 'orchestrator', label: 'Orchestrator' },
  ];

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-zinc-900/50 border border-zinc-800 rounded-2xl overflow-hidden"
    >
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h3 className="text-lg font-semibold text-zinc-100">{result.scenarioName}</h3>
            <p className="text-xs text-zinc-500 mt-1">
              {result.generalist.runs.length} test cases
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Trophy size={14} className="text-yellow-400" />
            <span className="text-sm font-medium text-yellow-400 capitalize">{result.winner}</span>
          </div>
        </div>

        {/* Score comparison */}
        <div className="space-y-2 mb-6">
          {agents.map(({ key, label }) => (
            <ScoreBar
              key={key}
              score={result[key].avgScore}
              color={AGENT_COLORS[key].accent}
              label={label}
            />
          ))}
        </div>

        {/* Metrics grid */}
        <div className="grid grid-cols-3 gap-3 mb-4">
          {agents.map(({ key, label }) => (
            <div key={key} className={`rounded-lg border ${AGENT_COLORS[key].border} bg-zinc-900 p-3`}>
              <div className="text-xs text-zinc-500 mb-2">{label}</div>
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs">
                  <span className="text-zinc-500">Tokens</span>
                  <span className="text-zinc-300 font-mono">
                    {(result[key].totalInputTokens + result[key].totalOutputTokens).toLocaleString()}
                  </span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-zinc-500">Cost</span>
                  <span className="text-zinc-300 font-mono">
                    ${result[key].totalCostUsd.toFixed(4)}
                  </span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-zinc-500">Avg Latency</span>
                  <span className="text-zinc-300 font-mono">
                    {Math.round(result[key].avgLatencyMs)}ms
                  </span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-zinc-500">Accuracy</span>
                  <span className={`font-mono font-bold ${
                    result[key].avgScore >= 0.8 ? 'text-emerald-400' :
                    result[key].avgScore >= 0.5 ? 'text-yellow-400' : 'text-red-400'
                  }`}>
                    {Math.round(result[key].avgScore * 100)}%
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Savings callout */}
        <div className="flex items-center gap-4 p-3 rounded-lg bg-indigo-500/5 border border-indigo-500/20">
          <div className="flex items-center gap-2">
            <DollarSign size={14} className="text-indigo-400" />
            <span className="text-xs text-indigo-300">
              Specialist saves <strong>{result.costSavings > 0 ? result.costSavings.toFixed(1) : '0'}%</strong> cost
            </span>
          </div>
          <div className="w-px h-4 bg-indigo-500/30" />
          <div className="flex items-center gap-2">
            <Target size={14} className="text-indigo-400" />
            <span className="text-xs text-indigo-300">
              <strong>{result.qualityGain > 0 ? '+' : ''}{result.qualityGain.toFixed(1)}%</strong> quality vs generalist
            </span>
          </div>
        </div>
      </div>

      {/* Expandable test case details */}
      <div className="border-t border-zinc-800">
        <button
          onClick={() => setShowDetails(!showDetails)}
          className="w-full flex items-center justify-center gap-2 px-4 py-3 text-xs text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900/50 transition-colors"
        >
          {showDetails ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {showDetails ? 'Hide' : 'Show'} individual test results
        </button>
        <AnimatePresence>
          {showDetails && (
            <motion.div
              initial={{ height: 0 }}
              animate={{ height: 'auto' }}
              exit={{ height: 0 }}
              className="overflow-hidden"
            >
              <div className="p-4 space-y-6">
                {agents.map(({ key, label }) => (
                  <div key={key}>
                    <h4 className={`text-sm font-medium ${AGENT_COLORS[key].text} mb-2`}>
                      {label} Results
                    </h4>
                    <div className="space-y-2">
                      {result[key].runs.map((run) => (
                        <TestCaseDetail key={run.testCaseId} run={run} agentType={label} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

function ProgressBar({ completed, total }: { completed: number; total: number }) {
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  return (
    <div className="w-full">
      <div className="flex justify-between text-xs text-zinc-500 mb-1">
        <span>{completed}/{total} API calls</span>
        <span>{pct}%</span>
      </div>
      <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
        <motion.div
          className="h-full bg-indigo-500 rounded-full"
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.3 }}
        />
      </div>
    </div>
  );
}

function SavedRunCard({ run, onLoad, onDelete }: {
  run: SavedRun;
  onLoad: () => void;
  onDelete: () => void;
}) {
  const date = new Date(run.timestamp);
  const modelLabel = run.model || 'Unknown model';

  return (
    <div className="flex items-center justify-between p-3 bg-zinc-900/50 border border-zinc-800 rounded-lg">
      <div className="flex items-center gap-3">
        <History size={14} className="text-zinc-500" />
        <div>
          <div className="text-xs text-zinc-300">
            {date.toLocaleDateString()} {date.toLocaleTimeString()}
          </div>
          <div className="text-xs text-zinc-500">
            {run.summary.totalScenarios} scenarios, {modelLabel} — Specialist: {Math.round(run.summary.avgSpecialistScore * 100)}% vs Gen: {Math.round(run.summary.avgGeneralistScore * 100)}%
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={onLoad}
          className="text-xs px-2 py-1 rounded bg-indigo-500/10 text-indigo-400 hover:bg-indigo-500/20 transition-colors"
        >
          Load
        </button>
        <button
          onClick={onDelete}
          className="text-xs p-1 rounded text-zinc-600 hover:text-red-400 hover:bg-red-500/10 transition-colors"
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
}

export default function BenchmarkPage() {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedScenarios, setSelectedScenarios] = useState<Set<string>>(new Set());
  const [selectedModel, setSelectedModel] = useState<string>('claude-haiku-4-5-20251001');
  const [results, setResults] = useState<BenchmarkResult[] | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingScenarios, setLoadingScenarios] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string>('');
  const [progressCount, setProgressCount] = useState<{ completed: number; total: number }>({ completed: 0, total: 0 });
  const [savedRuns, setSavedRuns] = useState<SavedRun[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    setSavedRuns(loadSavedRuns());
  }, []);

  const loadScenarios = useCallback(async () => {
    setLoadingScenarios(true);
    try {
      const res = await fetch('/api/benchmark');
      const data = await res.json();
      setScenarios(data.scenarios);
      setModels(data.models || []);
      setSelectedScenarios(new Set(data.scenarios.map((s: Scenario) => s.id)));
      if (data.models?.length > 0) {
        setSelectedModel(data.models[0].id);
      }
    } catch {
      setError('Failed to load scenarios');
    } finally {
      setLoadingScenarios(false);
    }
  }, []);

  useEffect(() => {
    loadScenarios();
  }, [loadScenarios]);

  const toggleScenario = (id: string) => {
    setSelectedScenarios(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const runBenchmark = async () => {
    if (selectedScenarios.size === 0) return;
    setLoading(true);
    setError(null);
    setResults(null);
    setSummary(null);
    setProgress('Connecting...');
    setProgressCount({ completed: 0, total: 0 });

    try {
      const scenarioIds = Array.from(selectedScenarios);

      const res = await fetch('/api/benchmark', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenarioIds, model: selectedModel }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Benchmark failed');
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response stream');

      const decoder = new TextDecoder();
      let buffer = '';
      const streamResults: BenchmarkResult[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events from buffer
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        let currentEvent = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7);
          } else if (line.startsWith('data: ') && currentEvent) {
            try {
              const data = JSON.parse(line.slice(6));

              switch (currentEvent) {
                case 'start':
                  setProgress(`Running benchmark with ${data.totalCalls} API calls...`);
                  setProgressCount({ completed: 0, total: data.totalCalls });
                  break;
                case 'progress':
                  setProgress(data.message);
                  setProgressCount({ completed: data.completed, total: data.total });
                  break;
                case 'scenario_start':
                  setProgress(`Running: ${data.scenarioName}...`);
                  break;
                case 'scenario_complete':
                  streamResults.push(data);
                  setResults([...streamResults]);
                  break;
                case 'complete':
                  setResults(data.results);
                  setSummary(data.summary);
                  setProgress('');

                  // Auto-save
                  const run: SavedRun = {
                    id: Date.now().toString(),
                    timestamp: new Date().toISOString(),
                    model: selectedModel,
                    results: data.results,
                    summary: data.summary,
                  };
                  saveRun(run);
                  setSavedRuns(loadSavedRuns());
                  break;
                case 'error':
                  throw new Error(data.error);
              }
            } catch (parseErr) {
              if (currentEvent === 'error') throw parseErr;
            }
            currentEvent = '';
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Benchmark failed');
      setProgress('');
    } finally {
      setLoading(false);
      setProgressCount({ completed: 0, total: 0 });
    }
  };

  const loadSavedRun = (run: SavedRun) => {
    setResults(run.results);
    setSummary(run.summary);
    setShowHistory(false);
  };

  const deleteSavedRun = (id: string) => {
    deleteRun(id);
    setSavedRuns(loadSavedRuns());
  };

  return (
    <div className="min-h-screen bg-zinc-950">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 py-12">
        {/* Header */}
        <div className="mb-10">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center">
              <BarChart3 size={20} className="text-indigo-400" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-zinc-100">Agent Marketplace Benchmark</h1>
              <p className="text-sm text-zinc-500">Prove the thesis: specialists outperform generalists</p>
            </div>
          </div>

          <div className="mt-4 p-4 rounded-xl bg-zinc-900/50 border border-zinc-800 text-sm text-zinc-400 space-y-2">
            <p>
              This benchmark runs <strong className="text-zinc-300">three agent types</strong> against identical tasks and measures quality, cost, and latency:
            </p>
            <div className="flex flex-wrap gap-4 mt-3">
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-zinc-600" />
                <span><strong className="text-zinc-300">Generalist</strong> — generic system prompt, does everything okay</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-indigo-500" />
                <span><strong className="text-indigo-300">Specialist</strong> — task-specific prompt with strict output format</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-emerald-500" />
                <span><strong className="text-emerald-300">Orchestrator</strong> — routes to specialist (2 API calls)</span>
              </div>
            </div>
          </div>
        </div>

        {/* Scenario selector */}
        <div className="mb-6">
          <h2 className="text-sm font-medium text-zinc-400 mb-3">Select Scenarios</h2>
          {loadingScenarios ? (
            <div className="flex items-center gap-2 text-sm text-zinc-500">
              <Loader2 size={14} className="animate-spin" />
              Loading scenarios...
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {scenarios.map(scenario => (
                <button
                  key={scenario.id}
                  onClick={() => toggleScenario(scenario.id)}
                  disabled={loading}
                  className={`p-4 rounded-xl border text-left transition-all ${
                    selectedScenarios.has(scenario.id)
                      ? 'bg-indigo-500/10 border-indigo-500/30 ring-1 ring-indigo-500/20'
                      : 'bg-zinc-900/50 border-zinc-800 hover:border-zinc-700'
                  } ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    {selectedScenarios.has(scenario.id) ? (
                      <CheckCircle2 size={14} className="text-indigo-400" />
                    ) : (
                      <div className="w-3.5 h-3.5 rounded-full border border-zinc-600" />
                    )}
                    <span className="text-sm font-medium text-zinc-200">{scenario.name}</span>
                  </div>
                  <p className="text-xs text-zinc-500 ml-5">{scenario.description}</p>
                  <p className="text-xs text-zinc-600 ml-5 mt-1">{scenario.testCaseCount} test cases</p>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Model selector */}
        {models.length > 0 && (
          <div className="mb-8">
            <h2 className="text-sm font-medium text-zinc-400 mb-3 flex items-center gap-2">
              <Cpu size={14} />
              Model
            </h2>
            <div className="flex flex-wrap gap-2">
              {models.map(model => (
                <button
                  key={model.id}
                  onClick={() => setSelectedModel(model.id)}
                  disabled={loading}
                  className={`px-4 py-2 rounded-lg border text-sm transition-all ${
                    selectedModel === model.id
                      ? 'bg-indigo-500/10 border-indigo-500/30 text-indigo-300'
                      : 'bg-zinc-900/50 border-zinc-800 text-zinc-400 hover:border-zinc-700'
                  } ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  <div className="font-medium">{model.label}</div>
                  <div className="text-xs text-zinc-500 mt-0.5">
                    ${model.inputCostPer1M}/M in, ${model.outputCostPer1M}/M out
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Run button + history */}
        <div className="mb-10 flex items-start gap-3">
          <button
            onClick={runBenchmark}
            disabled={loading || selectedScenarios.size === 0}
            className={`flex items-center gap-2 px-6 py-3 rounded-xl font-medium text-sm transition-all ${
              loading || selectedScenarios.size === 0
                ? 'bg-zinc-800 text-zinc-500 cursor-not-allowed'
                : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-500/20'
            }`}
          >
            {loading ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                Running Benchmark...
              </>
            ) : (
              <>
                <Play size={16} />
                Run Benchmark ({selectedScenarios.size} scenario{selectedScenarios.size !== 1 ? 's' : ''})
              </>
            )}
          </button>

          {savedRuns.length > 0 && (
            <button
              onClick={() => setShowHistory(!showHistory)}
              className="flex items-center gap-2 px-4 py-3 rounded-xl text-sm bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-zinc-300 hover:border-zinc-700 transition-all"
            >
              <History size={16} />
              History ({savedRuns.length})
            </button>
          )}
        </div>

        {/* Progress */}
        {loading && (
          <div className="mb-6 space-y-2">
            <div className="flex items-center gap-2 text-sm text-zinc-500">
              <Clock size={14} className="animate-pulse" />
              {progress}
            </div>
            {progressCount.total > 0 && (
              <ProgressBar completed={progressCount.completed} total={progressCount.total} />
            )}
          </div>
        )}

        {error && (
          <div className="mb-6 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-sm text-red-400">
            {error}
          </div>
        )}

        {/* Saved runs history */}
        <AnimatePresence>
          {showHistory && savedRuns.length > 0 && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="mb-8 overflow-hidden"
            >
              <h2 className="text-sm font-medium text-zinc-400 mb-3 flex items-center gap-2">
                <Save size={14} />
                Previous Runs (auto-saved)
              </h2>
              <div className="space-y-2">
                {savedRuns.map(run => (
                  <SavedRunCard
                    key={run.id}
                    run={run}
                    onLoad={() => loadSavedRun(run)}
                    onDelete={() => deleteSavedRun(run.id)}
                  />
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Summary cards */}
        <AnimatePresence>
          {summary && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="mb-10"
            >
              <h2 className="text-sm font-medium text-zinc-400 mb-3 flex items-center gap-2">
                <BarChart3 size={14} />
                Aggregate Results
                {summary.model && (
                  <span className="text-xs text-zinc-600 font-normal">
                    ({models.find(m => m.id === summary.model)?.label || summary.model})
                  </span>
                )}
              </h2>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <StatCard
                  icon={Target}
                  label="Generalist Accuracy"
                  value={`${Math.round(summary.avgGeneralistScore * 100)}%`}
                />
                <StatCard
                  icon={Target}
                  label="Specialist Accuracy"
                  value={`${Math.round(summary.avgSpecialistScore * 100)}%`}
                  subValue={`${summary.avgQualityGain > 0 ? '+' : ''}${summary.avgQualityGain.toFixed(1)}% vs gen.`}
                  trend={summary.avgQualityGain > 0 ? 'up' : 'down'}
                />
                <StatCard
                  icon={DollarSign}
                  label="Total Gen. Cost"
                  value={`$${summary.totalGeneralistCost.toFixed(4)}`}
                />
                <StatCard
                  icon={DollarSign}
                  label="Total Spec. Cost"
                  value={`$${summary.totalSpecialistCost.toFixed(4)}`}
                  subValue={`${summary.avgCostSavings > 0 ? '' : '+'}${(-summary.avgCostSavings).toFixed(1)}%`}
                  trend={summary.avgCostSavings > 0 ? 'up' : 'down'}
                />
              </div>

              {/* Thesis verdict */}
              <div className="mt-4 p-4 rounded-xl border bg-zinc-900/50 border-zinc-800">
                <div className="flex items-center gap-2 mb-2">
                  <Zap size={14} className="text-yellow-400" />
                  <span className="text-sm font-semibold text-zinc-200">Thesis Verdict</span>
                </div>
                {summary.avgSpecialistScore > summary.avgGeneralistScore ? (
                  <div className="space-y-2">
                    <p className="text-sm text-emerald-400 font-medium">
                      Specialists outperform generalists by {summary.avgQualityGain.toFixed(1)}% accuracy.
                    </p>
                    <p className="text-xs text-zinc-500">
                      Across {summary.totalTestCases} test cases in {summary.totalScenarios} scenarios,
                      specialist agents consistently delivered higher quality output.
                      {summary.avgCostSavings > 0
                        ? ` They also cost ${summary.avgCostSavings.toFixed(1)}% less due to more focused token usage.`
                        : ` The orchestrator adds routing overhead but maintains specialist-level quality.`
                      }
                    </p>
                    <div className="flex items-center gap-2 pt-2 text-xs text-zinc-400">
                      <ArrowRight size={12} />
                      <span>An agent marketplace where tasks route to specialists is economically viable.</span>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-sm text-yellow-400 font-medium">
                      Generalist matched or beat specialist in this run.
                    </p>
                    <p className="text-xs text-zinc-500">
                      This can happen with small sample sizes or simple tasks. Try running with more complex test cases
                      or check the individual results below for patterns.
                    </p>
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Individual scenario results */}
        {results && (
          <div className="space-y-6">
            <h2 className="text-sm font-medium text-zinc-400 flex items-center gap-2">
              <Target size={14} />
              Scenario Results
            </h2>
            {results.map(result => (
              <ScenarioCard key={result.scenarioId} result={result} />
            ))}
          </div>
        )}

        {/* Empty state */}
        {!results && !loading && (
          <div className="text-center py-20">
            <div className="w-16 h-16 rounded-2xl bg-zinc-900 border border-zinc-800 flex items-center justify-center mx-auto mb-4">
              <Play size={24} className="text-zinc-600" />
            </div>
            <p className="text-sm text-zinc-500">
              Select scenarios and hit Run to see the results.
            </p>
            <p className="text-xs text-zinc-600 mt-2">
              Each scenario runs 3 agent types against real test cases with ground truth scoring.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
