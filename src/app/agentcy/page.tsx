'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Send, Play, Users, CheckCircle, Clock, AlertCircle, XCircle, ChevronDown, ChevronRight, RotateCcw, Zap } from 'lucide-react';

// ─── Types ───────────────────────────────────────────────

interface AgentRole {
  id: string;
  name: string;
  slug: string;
  description: string;
  model: string;
  avatarColor: string;
  isActive: boolean;
}

interface Task {
  id: string;
  sprintId: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  assignedTo: string | null;
  createdBy: string | null;
  input: string | null;
  output: string | null;
  qaFeedback: string | null;
  qaScore: number | null;
  tokenCount: number;
  costUsd: number;
  latencyMs: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

interface Sprint {
  id: string;
  name: string;
  brief: string;
  status: string;
  summary: string | null;
  createdAt: string;
  completedAt: string | null;
  tasks: Task[];
}

// ─── Helpers ─────────────────────────────────────────────

const STATUS_CONFIG: Record<string, { icon: typeof CheckCircle; color: string; label: string }> = {
  pending: { icon: Clock, color: 'text-zinc-400', label: 'Pending' },
  in_progress: { icon: Zap, color: 'text-blue-400', label: 'Working' },
  in_review: { icon: AlertCircle, color: 'text-yellow-400', label: 'In Review' },
  approved: { icon: CheckCircle, color: 'text-green-400', label: 'Approved' },
  rejected: { icon: XCircle, color: 'text-red-400', label: 'Rejected' },
  revision: { icon: RotateCcw, color: 'text-orange-400', label: 'Needs Revision' },
};

const PRIORITY_COLORS: Record<string, string> = {
  urgent: 'bg-red-500/20 text-red-300 border-red-500/30',
  high: 'bg-orange-500/20 text-orange-300 border-orange-500/30',
  medium: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
  low: 'bg-zinc-500/20 text-zinc-400 border-zinc-500/30',
};

function parseSSE(
  url: string,
  body: object,
  onEvent: (event: string, data: unknown) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const reader = response.body?.getReader();
        if (!reader) throw new Error('No response body');

        const decoder = new TextDecoder();
        let buffer = '';

        function pump(): Promise<void> {
          return reader!.read().then(({ done, value }) => {
            if (done) { resolve(); return; }
            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            let currentEvent = '';
            for (const line of lines) {
              if (line.startsWith('event: ')) {
                currentEvent = line.slice(7);
              } else if (line.startsWith('data: ')) {
                try {
                  const data = JSON.parse(line.slice(6));
                  onEvent(currentEvent, data);
                } catch { /* skip unparseable */ }
              }
            }
            return pump();
          });
        }

        pump().catch(reject);
      })
      .catch(reject);
  });
}

// ─── Components ──────────────────────────────────────────

function RosterCard({ role }: { role: AgentRole }) {
  return (
    <div className="flex items-center gap-3 p-3 rounded-lg bg-zinc-900/50 border border-zinc-800">
      <div
        className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0"
        style={{ backgroundColor: role.avatarColor }}
      >
        {role.name.split(' ').map(w => w[0]).join('').slice(0, 2)}
      </div>
      <div className="min-w-0">
        <div className="text-sm font-medium text-zinc-100">{role.name}</div>
        <div className="text-xs text-zinc-500 truncate">{role.description}</div>
      </div>
      <div className={`ml-auto shrink-0 w-2 h-2 rounded-full ${role.isActive ? 'bg-green-400' : 'bg-zinc-600'}`} />
    </div>
  );
}

function TaskCard({
  task,
  roles,
  onRun,
  isRunning,
}: {
  task: Task;
  roles: AgentRole[];
  onRun: (taskId: string) => void;
  isRunning: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const status = STATUS_CONFIG[task.status] || STATUS_CONFIG.pending;
  const StatusIcon = status.icon;
  const role = roles.find(r => r.slug === task.assignedTo);
  const qaData = task.qaFeedback ? (() => { try { return JSON.parse(task.qaFeedback); } catch { return null; } })() : null;

  return (
    <div className="border border-zinc-800 rounded-lg overflow-hidden">
      <div
        className="flex items-center gap-3 p-3 cursor-pointer hover:bg-zinc-900/50 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <ChevronDown size={14} className="text-zinc-500 shrink-0" /> : <ChevronRight size={14} className="text-zinc-500 shrink-0" />}
        <StatusIcon size={14} className={`${status.color} shrink-0`} />
        <span className="text-sm text-zinc-200 truncate">{task.title}</span>
        <span className={`ml-auto shrink-0 text-[10px] px-2 py-0.5 rounded-full border ${PRIORITY_COLORS[task.priority] || PRIORITY_COLORS.medium}`}>
          {task.priority}
        </span>
        {role && (
          <div
            className="shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[9px] text-white font-bold"
            style={{ backgroundColor: role.avatarColor }}
            title={role.name}
          >
            {role.name.split(' ').map(w => w[0]).join('').slice(0, 2)}
          </div>
        )}
        {task.status === 'pending' && (
          <button
            onClick={(e) => { e.stopPropagation(); onRun(task.id); }}
            disabled={isRunning}
            className="shrink-0 px-2 py-1 rounded bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-xs font-medium transition-colors"
          >
            {isRunning ? 'Running...' : 'Run'}
          </button>
        )}
        {task.status === 'revision' && (
          <button
            onClick={(e) => { e.stopPropagation(); onRun(task.id); }}
            disabled={isRunning}
            className="shrink-0 px-2 py-1 rounded bg-orange-600 hover:bg-orange-500 disabled:bg-zinc-700 text-white text-xs font-medium transition-colors"
          >
            {isRunning ? 'Running...' : 'Retry'}
          </button>
        )}
        {task.qaScore && (
          <span className={`shrink-0 text-xs font-mono ${task.qaScore >= 4 ? 'text-green-400' : task.qaScore >= 3 ? 'text-yellow-400' : 'text-red-400'}`}>
            QA:{task.qaScore}/5
          </span>
        )}
      </div>

      {expanded && (
        <div className="border-t border-zinc-800 p-4 space-y-3 bg-zinc-950/50">
          <div>
            <div className="text-xs text-zinc-500 mb-1">Task Description</div>
            <div className="text-sm text-zinc-300 whitespace-pre-wrap">{task.description}</div>
          </div>

          {task.output && (
            <div>
              <div className="text-xs text-zinc-500 mb-1">Agent Output</div>
              <div className="text-sm text-zinc-200 whitespace-pre-wrap bg-zinc-900 rounded p-3 max-h-96 overflow-y-auto font-mono text-xs leading-relaxed">
                {task.output}
              </div>
            </div>
          )}

          {qaData && (
            <div>
              <div className="text-xs text-zinc-500 mb-1">QA Review</div>
              <div className="bg-zinc-900 rounded p-3 space-y-2">
                <div className="text-sm text-zinc-200">{qaData.summary}</div>
                {qaData.strengths?.length > 0 && (
                  <div>
                    <span className="text-xs text-green-400">Strengths: </span>
                    <span className="text-xs text-zinc-400">{qaData.strengths.join(' | ')}</span>
                  </div>
                )}
                {qaData.issues?.length > 0 && (
                  <div>
                    <span className="text-xs text-red-400">Issues: </span>
                    <span className="text-xs text-zinc-400">{qaData.issues.join(' | ')}</span>
                  </div>
                )}
                {qaData.suggestions?.length > 0 && (
                  <div>
                    <span className="text-xs text-yellow-400">Suggestions: </span>
                    <span className="text-xs text-zinc-400">{qaData.suggestions.join(' | ')}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {(task.costUsd > 0 || task.latencyMs > 0) && (
            <div className="flex gap-4 text-xs text-zinc-500">
              {task.costUsd > 0 && <span>Cost: ${task.costUsd.toFixed(4)}</span>}
              {task.tokenCount > 0 && <span>Tokens: {task.tokenCount.toLocaleString()}</span>}
              {task.latencyMs > 0 && <span>Time: {(task.latencyMs / 1000).toFixed(1)}s</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SprintView({
  sprint,
  roles,
  onRunTask,
  onRunAll,
  runningTasks,
}: {
  sprint: Sprint;
  roles: AgentRole[];
  onRunTask: (taskId: string) => void;
  onRunAll: (sprintId: string) => void;
  runningTasks: Set<string>;
}) {
  const [expanded, setExpanded] = useState(true);
  const pendingCount = sprint.tasks.filter(t => t.status === 'pending' || t.status === 'revision').length;
  const doneCount = sprint.tasks.filter(t => t.status === 'approved').length;
  const totalCost = sprint.tasks.reduce((sum, t) => sum + t.costUsd, 0);

  return (
    <div className="border border-zinc-800 rounded-xl overflow-hidden">
      <div
        className="flex items-center gap-3 p-4 bg-zinc-900/30 cursor-pointer hover:bg-zinc-900/50 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <ChevronDown size={16} className="text-zinc-400" /> : <ChevronRight size={16} className="text-zinc-400" />}
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-zinc-100">{sprint.name}</div>
          <div className="text-xs text-zinc-500 truncate">{sprint.brief.slice(0, 100)}{sprint.brief.length > 100 ? '...' : ''}</div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="text-xs text-zinc-500">{doneCount}/{sprint.tasks.length} done</span>
          {totalCost > 0 && <span className="text-xs text-zinc-600">${totalCost.toFixed(4)}</span>}
          {pendingCount > 0 && (
            <button
              onClick={(e) => { e.stopPropagation(); onRunAll(sprint.id); }}
              className="px-3 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition-colors flex items-center gap-1"
            >
              <Play size={12} /> Run All ({pendingCount})
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="p-4 space-y-2">
          {sprint.tasks.map(task => (
            <TaskCard
              key={task.id}
              task={task}
              roles={roles}
              onRun={onRunTask}
              isRunning={runningTasks.has(task.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────

export default function AgentcyPage() {
  const [roles, setRoles] = useState<AgentRole[]>([]);
  const [sprints, setSprints] = useState<Sprint[]>([]);
  const [brief, setBrief] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [runningTasks, setRunningTasks] = useState<Set<string>>(new Set());
  const [statusMessage, setStatusMessage] = useState('');
  const briefRef = useRef<HTMLTextAreaElement>(null);

  // Load data
  const loadData = useCallback(async () => {
    const [rolesRes, sprintsRes] = await Promise.all([
      fetch('/api/agentcy/roster').then(r => r.json()).catch(() => []),
      fetch('/api/agentcy/sprints').then(r => r.json()).catch(() => []),
    ]);
    setRoles(rolesRes);
    setSprints(sprintsRes);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // Submit a brief
  const submitBrief = async () => {
    if (!brief.trim() || isSubmitting) return;
    setIsSubmitting(true);
    setStatusMessage('Chief of Staff is analyzing your brief...');

    try {
      await parseSSE('/api/agentcy/brief', { brief }, (event, data) => {
        const d = data as Record<string, unknown>;
        if (event === 'status') setStatusMessage(d.message as string);
        if (event === 'chief_done') setStatusMessage(`Created ${d.taskCount} tasks (cost: $${(d.cost as number).toFixed(4)})`);
        if (event === 'task_created') setStatusMessage(`Task created: ${d.title}`);
        if (event === 'complete') {
          setStatusMessage('');
          setBrief('');
        }
        if (event === 'error') setStatusMessage(`Error: ${d.error}`);
      });
      await loadData();
    } catch (err) {
      setStatusMessage(`Error: ${err instanceof Error ? err.message : 'Unknown'}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Run a single task
  const runTask = async (taskId: string) => {
    setRunningTasks(prev => new Set(prev).add(taskId));
    setStatusMessage('Agent working...');

    try {
      await parseSSE('/api/agentcy/run', { taskId }, (event, data) => {
        const d = data as Record<string, unknown>;
        if (event === 'status') setStatusMessage(d.message as string);
        if (event === 'agent_done') setStatusMessage('QA is reviewing...');
        if (event === 'qa_done') setStatusMessage(`QA: ${d.verdict} (${d.score}/5) — ${d.summary}`);
        if (event === 'complete') setStatusMessage('');
        if (event === 'error') setStatusMessage(`Error: ${d.error}`);
      });
      await loadData();
    } catch (err) {
      setStatusMessage(`Error: ${err instanceof Error ? err.message : 'Unknown'}`);
    } finally {
      setRunningTasks(prev => {
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
    }
  };

  // Run all pending tasks in a sprint sequentially
  const runAllInSprint = async (sprintId: string) => {
    const sprint = sprints.find(s => s.id === sprintId);
    if (!sprint) return;

    const pending = sprint.tasks.filter(t => t.status === 'pending' || t.status === 'revision');
    for (const task of pending) {
      await runTask(task.id);
    }
  };

  // Stats
  const totalTasks = sprints.reduce((sum, s) => sum + s.tasks.length, 0);
  const completedTasks = sprints.reduce((sum, s) => sum + s.tasks.filter(t => t.status === 'approved').length, 0);
  const totalCost = sprints.reduce((sum, s) => sum + s.tasks.reduce((ts, t) => ts + t.costUsd, 0), 0);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 py-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-white">The Agentcy</h1>
          <p className="text-sm text-zinc-500 mt-1">Your internal AI team. Brief them, watch them work, review the output.</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          {/* Left sidebar — Roster */}
          <div className="lg:col-span-1 space-y-4">
            <div className="flex items-center gap-2 mb-2">
              <Users size={16} className="text-zinc-400" />
              <h2 className="text-sm font-semibold text-zinc-300">Your Team</h2>
            </div>
            {roles.map(role => (
              <RosterCard key={role.id} role={role} />
            ))}

            {/* Quick stats */}
            <div className="mt-6 p-4 rounded-lg bg-zinc-900/30 border border-zinc-800 space-y-2">
              <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Stats</h3>
              <div className="flex justify-between text-xs">
                <span className="text-zinc-500">Sprints</span>
                <span className="text-zinc-300">{sprints.length}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-zinc-500">Tasks</span>
                <span className="text-zinc-300">{completedTasks}/{totalTasks}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-zinc-500">Total Cost</span>
                <span className="text-zinc-300">${totalCost.toFixed(4)}</span>
              </div>
            </div>
          </div>

          {/* Main area */}
          <div className="lg:col-span-3 space-y-6">
            {/* Brief input */}
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 overflow-hidden">
              <div className="p-4">
                <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2 block">
                  Morning Brief
                </label>
                <textarea
                  ref={briefRef}
                  value={brief}
                  onChange={(e) => setBrief(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      submitBrief();
                    }
                  }}
                  placeholder="Tell your team what needs to get done today... (Cmd+Enter to send)"
                  className="w-full bg-transparent text-sm text-zinc-200 placeholder-zinc-600 resize-none focus:outline-none min-h-[100px]"
                  disabled={isSubmitting}
                />
              </div>
              <div className="flex items-center justify-between px-4 py-3 border-t border-zinc-800 bg-zinc-900/50">
                {statusMessage ? (
                  <span className="text-xs text-indigo-400 animate-pulse">{statusMessage}</span>
                ) : (
                  <span className="text-xs text-zinc-600">Chief of Staff will break this into tasks for your team</span>
                )}
                <button
                  onClick={submitBrief}
                  disabled={!brief.trim() || isSubmitting}
                  className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white text-sm font-medium transition-colors flex items-center gap-2"
                >
                  <Send size={14} />
                  {isSubmitting ? 'Working...' : 'Send Brief'}
                </button>
              </div>
            </div>

            {/* Sprints */}
            {sprints.length === 0 ? (
              <div className="text-center py-16 text-zinc-600">
                <Users size={40} className="mx-auto mb-3 opacity-30" />
                <p className="text-sm">No sprints yet. Send your first brief above to get your team working.</p>
              </div>
            ) : (
              <div className="space-y-4">
                {sprints.map(sprint => (
                  <SprintView
                    key={sprint.id}
                    sprint={sprint}
                    roles={roles}
                    onRunTask={runTask}
                    onRunAll={runAllInSprint}
                    runningTasks={runningTasks}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
