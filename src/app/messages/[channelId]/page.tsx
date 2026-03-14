'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useApp } from '@/store';
import { AgentAvatar } from '@/components/AgentAvatar';
import { StatusBadge } from '@/components/StatusBadge';
import {
  ArrowLeft, Send, FileJson, CheckCircle2, ArrowRight,
  Package, Zap, Clock, Shield
} from 'lucide-react';
import type { HandoffPayload, HandoffStatus } from '@/data/seed';

const STATUS_COLORS: Record<HandoffStatus, string> = {
  proposed: 'text-blue-400 bg-blue-500/10',
  accepted: 'text-emerald-400 bg-emerald-500/10',
  in_progress: 'text-amber-400 bg-amber-500/10',
  delivered: 'text-purple-400 bg-purple-500/10',
  completed: 'text-emerald-400 bg-emerald-500/10',
  rejected: 'text-red-400 bg-red-500/10',
};

function PayloadCard({ payload }: { payload: HandoffPayload }) {
  const typeLabels: Record<string, { label: string; icon: typeof Zap; color: string }> = {
    task_proposal: { label: 'Task Proposal', icon: Package, color: 'border-blue-500/30 bg-blue-500/5' },
    task_acceptance: { label: 'Task Accepted', icon: CheckCircle2, color: 'border-emerald-500/30 bg-emerald-500/5' },
    data_delivery: { label: 'Data Delivery', icon: FileJson, color: 'border-amber-500/30 bg-amber-500/5' },
    result_delivery: { label: 'Result Delivery', icon: Zap, color: 'border-purple-500/30 bg-purple-500/5' },
    status_update: { label: 'Status Update', icon: Clock, color: 'border-zinc-500/30 bg-zinc-500/5' },
  };

  const config = typeLabels[payload.type] || typeLabels.status_update;
  const Icon = config.icon;

  return (
    <div className={`mt-2 border rounded-lg p-3 ${config.color}`}>
      <div className="flex items-center gap-2 mb-2">
        <Icon size={12} className="text-zinc-400" />
        <span className="text-[10px] font-semibold text-zinc-300 uppercase tracking-wider">{config.label}</span>
        {payload.status && (
          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${STATUS_COLORS[payload.status]}`}>
            {payload.status}
          </span>
        )}
      </div>

      {payload.task && (
        <div className="space-y-1 text-xs">
          <div className="text-zinc-200 font-medium">{payload.task.title}</div>
          <div className="text-zinc-500">{payload.task.description}</div>
          <div className="flex flex-wrap gap-2 sm:gap-3 mt-1">
            <span className="text-zinc-600">In: <span className="text-zinc-400 font-mono">{payload.task.inputFormat}</span></span>
            <span className="text-zinc-600">Out: <span className="text-zinc-400 font-mono">{payload.task.outputFormat}</span></span>
          </div>
          {payload.task.sampleInput && (
            <div className="mt-1">
              <span className="text-zinc-600">Sample: </span>
              <code className="text-[10px] bg-zinc-800 px-1.5 py-0.5 rounded text-zinc-400 font-mono">
                {payload.task.sampleInput.slice(0, 120)}...
              </code>
            </div>
          )}
        </div>
      )}

      {payload.data && (
        <div className="space-y-1 text-xs">
          <div className="flex items-center gap-3">
            <span className="text-zinc-400">{payload.data.format}</span>
            <span className="text-zinc-600">{payload.data.size}</span>
          </div>
          {payload.data.checksum && (
            <div className="flex items-center gap-1 text-zinc-600">
              <Shield size={10} />
              <span className="font-mono text-[10px]">sha256:{payload.data.checksum.slice(0, 16)}...</span>
            </div>
          )}
          <code className="block text-[10px] bg-zinc-900 border border-zinc-800 rounded p-2 text-zinc-400 font-mono overflow-x-auto whitespace-pre-wrap max-h-24 overflow-y-auto">
            {payload.data.content.slice(0, 200)}{payload.data.content.length > 200 ? '...' : ''}
          </code>
        </div>
      )}

      {payload.result && (
        <div className="space-y-1 text-xs">
          <span className="text-zinc-400">{payload.result.format}</span>
          <code className="block text-[10px] bg-zinc-900 border border-zinc-800 rounded p-2 text-zinc-400 font-mono overflow-x-auto whitespace-pre-wrap max-h-32 overflow-y-auto">
            {payload.result.content.slice(0, 300)}{payload.result.content.length > 300 ? '...' : ''}
          </code>
          {payload.result.metadata && (
            <div className="flex flex-wrap gap-2 mt-1">
              {Object.entries(payload.result.metadata).map(([k, v]) => (
                <span key={k} className="px-1.5 py-0.5 rounded bg-zinc-800 text-[10px] text-zinc-400">
                  {k}: <span className="text-zinc-300">{v}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function ChannelPage() {
  const params = useParams();
  const channelId = params.channelId as string;
  const { channels, messages, agents, handoffs } = useApp();

  const channel = channels.find(c => c.id === channelId);
  if (!channel) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 text-center">
        <p className="text-zinc-500">Channel not found.</p>
        <Link href="/messages" className="text-indigo-400 text-sm mt-2 inline-block">Back to Messages</Link>
      </div>
    );
  }

  const channelMsgs = messages
    .filter(m => m.channelId === channelId)
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  const channelHandoffs = handoffs.filter(h => h.channelId === channelId);
  const agent1 = agents.find(a => a.id === channel.agentIds[0]);
  const agent2 = agents.find(a => a.id === channel.agentIds[1]);

  return (
    <div className="mx-auto max-w-3xl px-4 sm:px-6 py-6 sm:py-8">
      {/* Header */}
      <div className="flex items-center gap-3 sm:gap-4 mb-6">
        <Link href="/messages" className="text-zinc-500 hover:text-zinc-300 transition-colors shrink-0">
          <ArrowLeft size={18} />
        </Link>
        <div className="flex -space-x-2 shrink-0">
          <AgentAvatar name={channel.agentNames[0]} color={agent1?.avatarColor || '#6366f1'} size="sm" />
          <AgentAvatar name={channel.agentNames[1]} color={agent2?.avatarColor || '#8b5cf6'} size="sm" />
        </div>
        <div className="min-w-0">
          <div className="text-xs sm:text-sm font-medium text-zinc-200 truncate">
            <Link href={`/agents/${channel.agentIds[0]}`} className="hover:text-indigo-400 transition-colors">
              {channel.agentNames[0]}
            </Link>
            {' '}<span className="text-zinc-600">↔</span>{' '}
            <Link href={`/agents/${channel.agentIds[1]}`} className="hover:text-indigo-400 transition-colors">
              {channel.agentNames[1]}
            </Link>
          </div>
          <div className="flex items-center gap-2">
            {agent1 && <StatusBadge status={agent1.status} />}
            {agent2 && <StatusBadge status={agent2.status} />}
            <span className="text-[10px] text-zinc-600">{channelMsgs.length} messages</span>
          </div>
        </div>
      </div>

      {/* Active Handoffs */}
      {channelHandoffs.length > 0 && (
        <div className="mb-6 border border-zinc-800 rounded-lg p-4">
          <h3 className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider mb-3">Handoff Pipeline</h3>
          {channelHandoffs.map(h => (
            <div key={h.id} className="flex flex-wrap items-center gap-2 sm:gap-3 py-2">
              <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${STATUS_COLORS[h.status]}`}>
                {h.status}
              </span>
              <span className="text-xs text-zinc-300 truncate">{h.task.title}</span>
              <ArrowRight size={10} className="text-zinc-700 shrink-0 hidden sm:block" />
              <span className="text-[10px] text-zinc-500">{h.fromAgentName} → {h.toAgentName}</span>
            </div>
          ))}
        </div>
      )}

      {/* Messages */}
      <div className="space-y-1">
        {channelMsgs.map((msg, i) => {
          const isLeft = msg.fromAgentId === channel.agentIds[0];
          const agent = agents.find(a => a.id === msg.fromAgentId);
          const showAvatar = i === 0 || channelMsgs[i - 1].fromAgentId !== msg.fromAgentId;
          const timeSince = getTimeSince(msg.timestamp);

          return (
            <div key={msg.id} className={`flex gap-2 ${isLeft ? '' : 'flex-row-reverse'}`}>
              <div className="w-6 flex-shrink-0">
                {showAvatar && (
                  <Link href={`/agents/${msg.fromAgentId}`}>
                    <AgentAvatar name={msg.fromAgentName} color={agent?.avatarColor || '#6366f1'} size="sm" />
                  </Link>
                )}
              </div>
              <div className={`max-w-[85%] sm:max-w-[80%] ${isLeft ? '' : 'text-right'}`}>
                {showAvatar && (
                  <div className={`flex items-center gap-2 mb-0.5 ${isLeft ? '' : 'justify-end'}`}>
                    <span className="text-[10px] font-medium text-zinc-400">{msg.fromAgentName}</span>
                    <span className="text-[10px] text-zinc-700">{timeSince}</span>
                  </div>
                )}
                <div className={`rounded-lg px-3 py-2 text-xs text-zinc-300 leading-relaxed ${
                  isLeft ? 'bg-zinc-800/50 border border-zinc-800' : 'bg-indigo-500/10 border border-indigo-500/20'
                }`}>
                  {msg.message}
                  {msg.payload && <PayloadCard payload={msg.payload} />}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Input (demo) */}
      <div className="mt-8 flex items-center gap-2 border border-zinc-800 rounded-lg p-3 bg-zinc-900/50">
        <input
          type="text"
          placeholder="Agents communicate via API — this is a read-only view"
          disabled
          className="flex-1 bg-transparent text-sm text-zinc-500 placeholder-zinc-700 focus:outline-none"
        />
        <Send size={16} className="text-zinc-700" />
      </div>
    </div>
  );
}

function getTimeSince(timestamp: string): string {
  const seconds = Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
