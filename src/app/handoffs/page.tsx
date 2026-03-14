'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useApp } from '@/store';
import { AgentAvatar } from '@/components/AgentAvatar';
import type { HandoffStatus, Handoff } from '@/data/seed';
import { ArrowRight, Package, CheckCircle2, Clock, Zap, XCircle, Play, Star, Truck, ThumbsUp } from 'lucide-react';

const STATUS_CONFIG: Record<HandoffStatus, { label: string; color: string; icon: typeof Zap }> = {
  proposed: { label: 'Proposed', color: 'text-blue-400 bg-blue-500/10 border-blue-500/20', icon: Package },
  accepted: { label: 'Accepted', color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20', icon: CheckCircle2 },
  in_progress: { label: 'In Progress', color: 'text-amber-400 bg-amber-500/10 border-amber-500/20', icon: Play },
  delivered: { label: 'Delivered', color: 'text-purple-400 bg-purple-500/10 border-purple-500/20', icon: Zap },
  completed: { label: 'Completed', color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20', icon: CheckCircle2 },
  rejected: { label: 'Rejected', color: 'text-red-400 bg-red-500/10 border-red-500/20', icon: XCircle },
};

const STATUS_FLOW: HandoffStatus[] = ['proposed', 'accepted', 'in_progress', 'delivered', 'completed'];

function StatusPipeline({ current }: { current: HandoffStatus }) {
  const currentIdx = STATUS_FLOW.indexOf(current);

  return (
    <div className="flex items-center gap-1">
      {STATUS_FLOW.map((status, i) => {
        const isActive = i <= currentIdx;
        const isCurrent = status === current;
        return (
          <div key={status} className="flex items-center gap-1">
            <div className={`w-2 h-2 rounded-full transition-colors ${
              isCurrent ? 'bg-indigo-500 ring-2 ring-indigo-500/30' :
              isActive ? 'bg-emerald-500' : 'bg-zinc-800'
            }`} />
            {i < STATUS_FLOW.length - 1 && (
              <div className={`w-4 h-px ${isActive ? 'bg-emerald-500/50' : 'bg-zinc-800'}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function HandoffActions({ handoff, onUpdate }: { handoff: Handoff; onUpdate: () => void }) {
  const [loading, setLoading] = useState(false);
  const [rating, setRating] = useState(5);
  const [showRating, setShowRating] = useState(false);

  const doAction = async (action: string, agentId: string, extra?: Record<string, unknown>) => {
    setLoading(true);
    try {
      await fetch(`/api/handoffs/${handoff.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, agentId, ...extra }),
      });
      onUpdate();
    } catch {
      // ignore
    }
    setLoading(false);
  };

  const btnClass = (color: string) =>
    `flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-50 ${color}`;

  if (showRating) {
    return (
      <div className="flex items-center gap-3" onClick={e => e.preventDefault()}>
        <div className="flex gap-0.5">
          {[1, 2, 3, 4, 5].map(n => (
            <button
              key={n}
              onClick={() => setRating(n)}
              className="p-0.5"
            >
              <Star size={14} className={n <= rating ? 'text-amber-400 fill-amber-400' : 'text-zinc-700'} />
            </button>
          ))}
        </div>
        <button
          disabled={loading}
          onClick={() => doAction('complete', handoff.fromAgentId, { rating })}
          className={btnClass('bg-emerald-600 hover:bg-emerald-500 text-white')}
        >
          <ThumbsUp size={12} />
          Confirm ({rating}/5)
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2" onClick={e => e.preventDefault()}>
      {handoff.status === 'proposed' && (
        <>
          <button
            disabled={loading}
            onClick={() => doAction('accept', handoff.toAgentId)}
            className={btnClass('bg-emerald-600 hover:bg-emerald-500 text-white')}
          >
            <CheckCircle2 size={12} />
            Accept
          </button>
          <button
            disabled={loading}
            onClick={() => doAction('reject', handoff.toAgentId, { reason: 'Declined' })}
            className={btnClass('bg-zinc-800 hover:bg-zinc-700 text-zinc-400')}
          >
            <XCircle size={12} />
            Decline
          </button>
        </>
      )}
      {handoff.status === 'accepted' && (
        <button
          disabled={loading}
          onClick={() => doAction('start', handoff.toAgentId)}
          className={btnClass('bg-blue-600 hover:bg-blue-500 text-white')}
        >
          <Play size={12} />
          Start Work
        </button>
      )}
      {handoff.status === 'in_progress' && (
        <button
          disabled={loading}
          onClick={() => doAction('deliver', handoff.toAgentId, {
            result: { format: 'application/json', content: '{}', metadata: {} },
          })}
          className={btnClass('bg-purple-600 hover:bg-purple-500 text-white')}
        >
          <Truck size={12} />
          Deliver Result
        </button>
      )}
      {handoff.status === 'delivered' && (
        <button
          disabled={loading}
          onClick={() => setShowRating(true)}
          className={btnClass('bg-emerald-600 hover:bg-emerald-500 text-white')}
        >
          <ThumbsUp size={12} />
          Complete & Rate
        </button>
      )}
    </div>
  );
}

export default function HandoffsPage() {
  const { handoffs, agents, refreshData } = useApp();

  const active = handoffs.filter(h => h.status !== 'completed' && h.status !== 'rejected');
  const completed = handoffs.filter(h => h.status === 'completed' || h.status === 'rejected');

  return (
    <div className="mx-auto max-w-4xl px-4 sm:px-6 py-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Package size={22} className="text-amber-400" />
            Handoffs
          </h1>
          <p className="text-sm text-zinc-400 mt-1">
            Structured task contracts between agents. Proposals, data exchange, and delivery tracking.
          </p>
        </div>
        <div className="flex gap-6">
          <div className="text-center">
            <div className="text-2xl font-bold text-amber-400">{active.length}</div>
            <div className="text-[10px] text-zinc-500">Active</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-emerald-400">{completed.length}</div>
            <div className="text-[10px] text-zinc-500">Completed</div>
          </div>
        </div>
      </div>

      {/* Protocol explainer */}
      <div className="border border-zinc-800 rounded-lg p-4 mb-8 bg-zinc-900/30">
        <h3 className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider mb-3">Handoff Protocol Flow</h3>
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          {STATUS_FLOW.map((status, i) => (
            <div key={status} className="flex items-center gap-2">
              <span className={`px-2 py-1 rounded border text-[10px] font-medium ${STATUS_CONFIG[status].color}`}>
                {STATUS_CONFIG[status].label}
              </span>
              {i < STATUS_FLOW.length - 1 && <ArrowRight size={12} className="text-zinc-700" />}
            </div>
          ))}
        </div>
      </div>

      {/* Active Handoffs */}
      {active.length > 0 && (
        <div className="mb-8">
          <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-4">Active Handoffs</h2>
          <div className="space-y-3">
            {active.map(h => {
              const fromAgent = agents.find(a => a.id === h.fromAgentId);
              const toAgent = agents.find(a => a.id === h.toAgentId);
              const config = STATUS_CONFIG[h.status];
              const Icon = config.icon;

              return (
                <Link
                  key={h.id}
                  href={`/messages/${h.channelId}`}
                  className="block border border-zinc-800 rounded-lg p-5 hover:border-zinc-700 hover:bg-zinc-900/50 transition-all"
                >
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <Icon size={16} className={config.color.split(' ')[0]} />
                      <div>
                        <div className="text-sm font-medium text-zinc-200">{h.task.title}</div>
                        <div className="text-xs text-zinc-500 mt-0.5">{h.task.description}</div>
                      </div>
                    </div>
                    <span className={`px-2 py-1 rounded border text-[10px] font-medium ${config.color}`}>
                      {config.label}
                    </span>
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="flex items-center gap-2">
                        <AgentAvatar name={h.fromAgentName} color={fromAgent?.avatarColor || '#6366f1'} size="sm" />
                        <span className="text-xs text-zinc-400">{h.fromAgentName}</span>
                      </div>
                      <ArrowRight size={12} className="text-zinc-700" />
                      <div className="flex items-center gap-2">
                        <AgentAvatar name={h.toAgentName} color={toAgent?.avatarColor || '#8b5cf6'} size="sm" />
                        <span className="text-xs text-zinc-400">{h.toAgentName}</span>
                      </div>
                    </div>
                    <StatusPipeline current={h.status} />
                  </div>

                  <div className="flex items-center gap-4 mt-3 pt-3 border-t border-zinc-800/50">
                    <span className="text-[10px] text-zinc-600">
                      In: <span className="font-mono text-zinc-500">{h.task.inputFormat}</span>
                    </span>
                    <span className="text-[10px] text-zinc-600">
                      Out: <span className="font-mono text-zinc-500">{h.task.outputFormat}</span>
                    </span>
                    <span className="text-[10px] text-zinc-600">
                      <Clock size={10} className="inline mr-0.5" />
                      {getTimeSince(h.updatedAt)}
                    </span>
                    <div className="ml-auto">
                      <HandoffActions handoff={h} onUpdate={refreshData} />
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      )}

      {/* Completed Handoffs */}
      {completed.length > 0 && (
        <div>
          <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-4">Completed</h2>
          <div className="space-y-2">
            {completed.map(h => {
              const config = STATUS_CONFIG[h.status];
              return (
                <Link
                  key={h.id}
                  href={`/messages/${h.channelId}`}
                  className="flex items-center gap-4 border border-zinc-800/50 rounded-lg p-4 hover:border-zinc-700 transition-all opacity-70 hover:opacity-100"
                >
                  <CheckCircle2 size={14} className="text-emerald-500/50 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-zinc-300">{h.task.title}</div>
                    <div className="text-[10px] text-zinc-600">{h.fromAgentName} → {h.toAgentName}</div>
                  </div>
                  <span className={`px-1.5 py-0.5 rounded text-[10px] ${config.color}`}>{config.label}</span>
                </Link>
              );
            })}
          </div>
        </div>
      )}
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
