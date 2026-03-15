'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Send, Play, Users, CheckCircle, Clock, AlertCircle, XCircle, ChevronDown, ChevronRight, Zap, MessageSquare, ArrowRight, Settings } from 'lucide-react';

// ─── Types ───────────────────────────────────────────────

interface AgentRecord {
  id: string;
  name: string;
  avatarColor: string;
  bio: string;
  status: string;
  trustTier: string;
  reputationScore: number;
  tasksCompleted: number;
  successRate: number;
  skills: { name: string }[];
  hasApiKey?: boolean;
}

interface HandoffTask {
  title: string;
  description: string;
  priority?: string;
}

interface HandoffResult {
  format: string;
  content: string;
  metadata?: {
    model?: string;
    costUsd?: number;
    latencyMs?: number;
    toolCalls?: unknown[];
  };
}

interface Handoff {
  id: string;
  fromAgentId: string;
  fromAgentName: string;
  toAgentId: string;
  toAgentName: string;
  channelId: string;
  status: string;
  task: HandoffTask;
  result: HandoffResult | null;
  rating: number | null;
  review: string | null;
  price: number | null;
  createdAt: string;
  deliveredAt: string | null;
  completedAt: string | null;
}

interface DMMessage {
  id: string;
  fromAgentId: string;
  fromAgentName: string;
  toAgentName: string;
  message: string;
  payload?: { type: string; handoffId?: string; review?: string };
  timestamp: string;
}

interface DMChannel {
  id: string;
  agent1Id: string;
  agent1Name: string;
  agent2Id: string;
  agent2Name: string;
  lastMessageAt: string;
}

// ─── Helpers ─────────────────────────────────────────────

const HANDOFF_STATUS: Record<string, { icon: typeof CheckCircle; color: string; label: string }> = {
  proposed: { icon: Clock, color: 'text-zinc-400', label: 'Proposed' },
  accepted: { icon: Zap, color: 'text-blue-400', label: 'Accepted' },
  in_progress: { icon: Zap, color: 'text-blue-400', label: 'Working' },
  delivered: { icon: AlertCircle, color: 'text-yellow-400', label: 'Delivered' },
  completed: { icon: CheckCircle, color: 'text-green-400', label: 'Completed' },
  rejected: { icon: XCircle, color: 'text-red-400', label: 'Rejected' },
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

function getSlugFromName(name: string): string {
  return name.replace('Agentcy: ', '').toLowerCase().replace(/\s+/g, '-');
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ─── Components ──────────────────────────────────────────

function AgentCard({ agent }: { agent: AgentRecord }) {
  const displayName = agent.name.replace('Agentcy: ', '');
  return (
    <div className="flex items-center gap-3 p-3 rounded-lg hover:bg-zinc-900/50 transition-colors">
      <div
        className="w-9 h-9 rounded-full flex items-center justify-center text-xs text-white font-bold shrink-0"
        style={{ backgroundColor: agent.avatarColor }}
      >
        {displayName.split(' ').map(w => w[0]).join('').slice(0, 2)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-zinc-100">{displayName}</div>
        <div className="text-xs text-zinc-500 truncate">{agent.bio}</div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {agent.tasksCompleted > 0 && (
          <span className="text-[10px] text-zinc-600">{agent.tasksCompleted} done</span>
        )}
        <div className={`w-2 h-2 rounded-full ${agent.status === 'online' ? 'bg-green-400' : 'bg-zinc-600'}`} />
      </div>
    </div>
  );
}

function HandoffCard({
  handoff,
  agents,
  onProcess,
  isProcessing,
}: {
  handoff: Handoff;
  agents: AgentRecord[];
  onProcess: (handoffId: string) => void;
  isProcessing: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const status = HANDOFF_STATUS[handoff.status] || HANDOFF_STATUS.proposed;
  const StatusIcon = status.icon;
  const priority = handoff.task.priority || 'medium';
  const workerName = handoff.toAgentName.replace('Agentcy: ', '');
  const worker = agents.find(a => a.id === handoff.toAgentId);
  const costUsd = handoff.result?.metadata?.costUsd;

  return (
    <div className="border border-zinc-800 rounded-lg overflow-hidden">
      <div
        className="flex items-center gap-3 p-3 cursor-pointer hover:bg-zinc-900/50 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <ChevronDown size={14} className="text-zinc-500 shrink-0" /> : <ChevronRight size={14} className="text-zinc-500 shrink-0" />}
        <StatusIcon size={14} className={`${status.color} shrink-0`} />
        <span className="text-sm text-zinc-200 truncate">{handoff.task.title}</span>
        <span className={`ml-auto shrink-0 text-[10px] px-2 py-0.5 rounded-full border ${PRIORITY_COLORS[priority] || PRIORITY_COLORS.medium}`}>
          {priority}
        </span>
        {worker && (
          <div
            className="shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[9px] text-white font-bold"
            style={{ backgroundColor: worker.avatarColor }}
            title={workerName}
          >
            {workerName.split(' ').map(w => w[0]).join('').slice(0, 2)}
          </div>
        )}
        {handoff.status === 'proposed' && (
          <button
            onClick={(e) => { e.stopPropagation(); onProcess(handoff.id); }}
            disabled={isProcessing}
            className="px-2 py-1 rounded bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-700 text-white text-xs font-medium transition-colors flex items-center gap-1"
          >
            {isProcessing ? <Zap size={10} className="animate-pulse" /> : <Play size={10} />}
            {isProcessing ? 'Running...' : 'Run'}
          </button>
        )}
        {handoff.rating && (
          <span className="text-xs text-yellow-400 shrink-0">{'★'.repeat(handoff.rating)}</span>
        )}
        {costUsd != null && costUsd > 0 && (
          <span className="text-[10px] text-zinc-600 shrink-0">${costUsd.toFixed(4)}</span>
        )}
      </div>

      {expanded && (
        <div className="p-4 border-t border-zinc-800 space-y-3">
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <span>{handoff.fromAgentName.replace('Agentcy: ', '')}</span>
            <ArrowRight size={10} />
            <span>{workerName}</span>
            <span className="ml-auto">{timeAgo(handoff.createdAt)}</span>
          </div>
          <p className="text-xs text-zinc-400 whitespace-pre-wrap">{handoff.task.description}</p>

          {handoff.result?.content && (
            <div className="mt-3 p-3 rounded bg-zinc-900/60 border border-zinc-800">
              <div className="text-[10px] text-zinc-600 uppercase tracking-wider mb-2 font-semibold">Deliverable</div>
              <div className="text-xs text-zinc-300 whitespace-pre-wrap max-h-64 overflow-y-auto">{handoff.result.content}</div>
              {handoff.result.metadata && (
                <div className="flex gap-3 mt-2 pt-2 border-t border-zinc-800">
                  {handoff.result.metadata.model && <span className="text-[10px] text-zinc-600">{handoff.result.metadata.model}</span>}
                  {handoff.result.metadata.latencyMs && <span className="text-[10px] text-zinc-600">{(handoff.result.metadata.latencyMs / 1000).toFixed(1)}s</span>}
                  {handoff.result.metadata.toolCalls && handoff.result.metadata.toolCalls.length > 0 && (
                    <span className="text-[10px] text-zinc-600">{handoff.result.metadata.toolCalls.length} tool calls</span>
                  )}
                </div>
              )}
            </div>
          )}

          {handoff.review && (
            <div className="text-xs text-zinc-500 italic">QA: {handoff.review}</div>
          )}
        </div>
      )}
    </div>
  );
}

function ChannelView({
  channel,
  messages,
  isSelected,
  onSelect,
}: {
  channel: DMChannel;
  messages: DMMessage[];
  isSelected: boolean;
  onSelect: () => void;
}) {
  const lastMsg = messages[messages.length - 1];
  const otherName = channel.agent1Name.includes('Chief') ? channel.agent2Name : channel.agent1Name;
  const displayName = otherName.replace('Agentcy: ', '');

  return (
    <div
      className={`p-3 rounded-lg cursor-pointer transition-colors ${isSelected ? 'bg-zinc-800/60 border border-zinc-700' : 'hover:bg-zinc-900/50'}`}
      onClick={onSelect}
    >
      <div className="flex items-center gap-2">
        <MessageSquare size={12} className="text-zinc-500" />
        <span className="text-xs font-medium text-zinc-300">{displayName}</span>
        <span className="text-[10px] text-zinc-600 ml-auto">{timeAgo(channel.lastMessageAt)}</span>
      </div>
      {lastMsg && (
        <div className="text-[10px] text-zinc-600 truncate mt-1 ml-4">{lastMsg.message}</div>
      )}
    </div>
  );
}

function MessageThread({ messages }: { messages: DMMessage[] }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages.length]);

  return (
    <div className="space-y-2 max-h-80 overflow-y-auto p-3">
      {messages.map(msg => (
        <div key={msg.id} className="flex gap-2">
          <div className="text-[10px] text-zinc-600 shrink-0 w-16 text-right pt-0.5">{timeAgo(msg.timestamp)}</div>
          <div>
            <span className="text-xs font-medium text-zinc-400">{msg.fromAgentName.replace('Agentcy: ', '')}</span>
            <p className="text-xs text-zinc-300">{msg.message}</p>
          </div>
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────

export default function OpsHub() {
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [handoffs, setHandoffs] = useState<Handoff[]>([]);
  const [channels, setChannels] = useState<DMChannel[]>([]);
  const [channelMessages, setChannelMessages] = useState<Record<string, DMMessage[]>>({});
  const [selectedChannel, setSelectedChannel] = useState<string | null>(null);
  const [brief, setBrief] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [processingHandoffs, setProcessingHandoffs] = useState<Set<string>>(new Set());
  const [statusMessage, setStatusMessage] = useState('');
  const [isSetup, setIsSetup] = useState<boolean | null>(null);
  const briefRef = useRef<HTMLTextAreaElement>(null);

  // Load team data from the real agent directory
  const loadData = useCallback(async () => {
    try {
      // Check setup status
      const setupRes = await fetch('/api/agentcy/setup').then(r => r.json()).catch(() => ({ registered: false, agents: [] }));
      setIsSetup(setupRes.registered);

      if (setupRes.registered && setupRes.agents.length > 0) {
        setAgents(setupRes.agents);

        // Load handoffs for agentcy agents
        const agentIds = setupRes.agents.map((a: AgentRecord) => a.id);
        const allHandoffs: Handoff[] = [];
        const allChannels: DMChannel[] = [];
        const allMessages: Record<string, DMMessage[]> = {};

        // Fetch handoffs and channels for each agent
        for (const agent of setupRes.agents) {
          const [handoffsRes, channelsRes] = await Promise.all([
            fetch(`/api/agentcy/handoffs?agentId=${agent.id}`).then(r => r.json()).catch(() => []),
            fetch(`/api/agentcy/channels?agentId=${agent.id}`).then(r => r.json()).catch(() => []),
          ]);

          if (Array.isArray(handoffsRes)) {
            for (const h of handoffsRes) {
              if (!allHandoffs.find(existing => existing.id === h.id)) {
                allHandoffs.push(h);
              }
            }
          }

          if (Array.isArray(channelsRes)) {
            for (const ch of channelsRes) {
              if (!allChannels.find(existing => existing.id === ch.id)) {
                allChannels.push(ch);
              }
            }
          }
        }

        // Sort handoffs newest first
        allHandoffs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        allChannels.sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime());

        setHandoffs(allHandoffs);
        setChannels(allChannels);

        // Load messages for each channel
        for (const ch of allChannels) {
          const msgs = await fetch(`/api/agentcy/messages?channelId=${ch.id}`).then(r => r.json()).catch(() => []);
          if (Array.isArray(msgs)) {
            allMessages[ch.id] = msgs;
          }
        }
        setChannelMessages(allMessages);
      }
    } catch {
      // Graceful degradation
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // Setup the team
  const setupTeam = async () => {
    setStatusMessage('Registering your team in the directory...');
    try {
      await fetch('/api/agentcy/setup', { method: 'POST' });
      setStatusMessage('Team registered!');
      await loadData();
      setStatusMessage('');
    } catch (err) {
      setStatusMessage(`Setup failed: ${err instanceof Error ? err.message : 'Unknown'}`);
    }
  };

  // Submit a brief
  const submitBrief = async () => {
    if (!brief.trim() || isSubmitting) return;
    setIsSubmitting(true);
    setStatusMessage('Chief of Staff is analyzing your brief...');

    try {
      await parseSSE('/api/agentcy/brief', { brief }, (event, data) => {
        const d = data as Record<string, unknown>;
        if (event === 'status') setStatusMessage(d.message as string);
        if (event === 'chief_done') setStatusMessage(`Created ${d.taskCount} handoffs (cost: $${(d.cost as number).toFixed(4)})`);
        if (event === 'handoff_created') setStatusMessage(`Handoff → ${(d.workerName as string).replace('Agentcy: ', '')}: ${d.title}`);
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

  // Process a handoff (accept → run → deliver)
  const processHandoff = async (handoffId: string) => {
    setProcessingHandoffs(prev => new Set(prev).add(handoffId));
    setStatusMessage('Agent working...');

    try {
      await parseSSE('/api/agentcy/process', { handoffId }, (event, data) => {
        const d = data as Record<string, unknown>;
        if (event === 'status') setStatusMessage(d.message as string);
        if (event === 'agent_done') setStatusMessage(`Done — ${d.toolCalls || 0} tool calls, $${(d.cost as number).toFixed(4)}`);
        if (event === 'qa_done') setStatusMessage(`QA: ${d.verdict} (${d.score}/5) — ${d.summary}`);
        if (event === 'complete') setStatusMessage('');
        if (event === 'error') setStatusMessage(`Error: ${d.error}`);
      });
      await loadData();
    } catch (err) {
      setStatusMessage(`Error: ${err instanceof Error ? err.message : 'Unknown'}`);
    } finally {
      setProcessingHandoffs(prev => {
        const next = new Set(prev);
        next.delete(handoffId);
        return next;
      });
    }
  };

  // Run all pending handoffs
  const runAllPending = async () => {
    const pending = handoffs.filter(h => h.status === 'proposed');
    for (const h of pending) {
      await processHandoff(h.id);
    }
  };

  // Stats
  const totalHandoffs = handoffs.length;
  const completedHandoffs = handoffs.filter(h => h.status === 'completed').length;
  const pendingHandoffs = handoffs.filter(h => h.status === 'proposed').length;
  const totalCost = handoffs.reduce((sum, h) => sum + (h.result?.metadata?.costUsd || 0), 0);
  const avgRating = (() => {
    const rated = handoffs.filter(h => h.rating);
    return rated.length > 0 ? (rated.reduce((sum, h) => sum + (h.rating || 0), 0) / rated.length).toFixed(1) : '—';
  })();

  // Show setup screen if not registered
  if (isSetup === false) {
    return (
      <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center">
        <div className="text-center max-w-md mx-auto px-4">
          <Users size={48} className="mx-auto mb-4 text-indigo-400" />
          <h1 className="text-2xl font-bold text-white mb-2">Set Up Your Team</h1>
          <p className="text-sm text-zinc-400 mb-6">
            Register your AI team (Chief of Staff, CFO, Support Lead, Client Care, and more) as agents in the directory. They&apos;ll use DMs and handoffs to coordinate work.
          </p>
          <button
            onClick={setupTeam}
            className="px-6 py-3 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium transition-colors"
          >
            Register Team
          </button>
          {statusMessage && (
            <p className="mt-4 text-xs text-indigo-400 animate-pulse">{statusMessage}</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-8">
        {/* Header */}
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white">Ops Hub</h1>
            <p className="text-sm text-zinc-500 mt-1">Your internal AI team. Brief them, watch them work, review the output.</p>
          </div>
          {pendingHandoffs > 0 && (
            <button
              onClick={runAllPending}
              className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors flex items-center gap-2"
            >
              <Play size={14} />
              Run All ({pendingHandoffs})
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Left sidebar — Team + DMs */}
          <div className="lg:col-span-3 space-y-6">
            {/* Team roster */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Users size={14} className="text-zinc-400" />
                <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Your Team</h2>
              </div>
              <div className="space-y-1">
                {agents.map(agent => (
                  <AgentCard key={agent.id} agent={agent} />
                ))}
              </div>
            </div>

            {/* Stats */}
            <div className="p-4 rounded-lg bg-zinc-900/30 border border-zinc-800 space-y-2">
              <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Stats</h3>
              <div className="flex justify-between text-xs">
                <span className="text-zinc-500">Handoffs</span>
                <span className="text-zinc-300">{completedHandoffs}/{totalHandoffs}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-zinc-500">Avg Rating</span>
                <span className="text-zinc-300">{avgRating}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-zinc-500">Total Cost</span>
                <span className="text-zinc-300">${totalCost.toFixed(4)}</span>
              </div>
            </div>

            {/* DM Channels */}
            {channels.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <MessageSquare size={14} className="text-zinc-400" />
                  <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Channels</h2>
                </div>
                <div className="space-y-1">
                  {channels.map(ch => (
                    <ChannelView
                      key={ch.id}
                      channel={ch}
                      messages={channelMessages[ch.id] || []}
                      isSelected={selectedChannel === ch.id}
                      onSelect={() => setSelectedChannel(selectedChannel === ch.id ? null : ch.id)}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Main area */}
          <div className="lg:col-span-9 space-y-6">
            {/* Brief input */}
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 overflow-hidden">
              <div className="p-4">
                <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2 block">
                  Brief Your Team
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
                  placeholder="Tell your team what needs to get done... (Cmd+Enter to send)"
                  className="w-full bg-transparent text-sm text-zinc-200 placeholder-zinc-600 resize-none focus:outline-none min-h-[100px]"
                  disabled={isSubmitting}
                />
              </div>
              <div className="flex items-center justify-between px-4 py-3 border-t border-zinc-800 bg-zinc-900/50">
                {statusMessage ? (
                  <span className="text-xs text-indigo-400 animate-pulse">{statusMessage}</span>
                ) : (
                  <span className="text-xs text-zinc-600">Chief of Staff will create handoffs for your team</span>
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

            {/* Selected channel messages */}
            {selectedChannel && channelMessages[selectedChannel] && (
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 overflow-hidden">
                <div className="px-4 py-2 border-b border-zinc-800 flex items-center justify-between">
                  <span className="text-xs font-semibold text-zinc-400">
                    {(() => {
                      const ch = channels.find(c => c.id === selectedChannel);
                      return ch ? `${ch.agent1Name.replace('Agentcy: ', '')} ↔ ${ch.agent2Name.replace('Agentcy: ', '')}` : 'Channel';
                    })()}
                  </span>
                  <button onClick={() => setSelectedChannel(null)} className="text-zinc-600 hover:text-zinc-400">
                    <XCircle size={14} />
                  </button>
                </div>
                <MessageThread messages={channelMessages[selectedChannel]} />
              </div>
            )}

            {/* Handoffs pipeline */}
            {handoffs.length === 0 ? (
              <div className="text-center py-16 text-zinc-600">
                <Users size={40} className="mx-auto mb-3 opacity-30" />
                <p className="text-sm">No handoffs yet. Send your first brief above to get your team working.</p>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center gap-2 mb-3">
                  <Zap size={14} className="text-zinc-400" />
                  <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Handoffs</h2>
                  <span className="text-[10px] text-zinc-600 ml-auto">{handoffs.length} total</span>
                </div>
                {handoffs.map(handoff => (
                  <HandoffCard
                    key={handoff.id}
                    handoff={handoff}
                    agents={agents}
                    onProcess={processHandoff}
                    isProcessing={processingHandoffs.has(handoff.id)}
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
