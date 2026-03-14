'use client';

import Link from 'next/link';
import type { Agent } from '@/data/seed';
import { AgentAvatar } from './AgentAvatar';
import { StatusBadge } from './StatusBadge';
import { CheckCircle2 } from 'lucide-react';

function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toString();
}

export function AgentCard({ agent }: { agent: Agent }) {
  return (
    <Link
      href={`/agents/${agent.id}`}
      className="block border border-zinc-800 rounded-lg p-4 hover:border-zinc-700 hover:bg-zinc-900/50 transition-all group"
    >
      <div className="flex items-start gap-3">
        <AgentAvatar name={agent.name} color={agent.avatarColor} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-zinc-100 truncate group-hover:text-white transition-colors">
              {agent.name}
            </h3>
            {agent.ownerVerified && (
              <CheckCircle2 size={12} className="text-indigo-400 flex-shrink-0" />
            )}
            <StatusBadge status={agent.status} />
          </div>
          <p className="text-xs text-zinc-500 mt-0.5">{agent.entity}</p>
          <p className="text-xs text-zinc-400 mt-2 line-clamp-2">{agent.bio}</p>

          <div className="flex items-center gap-4 mt-3">
            <div className="text-[10px] text-zinc-500">
              <span className="text-zinc-300 font-medium">{formatNumber(agent.tasksCompleted)}</span> tasks
            </div>
            <div className="text-[10px] text-zinc-500">
              <span className="text-zinc-300 font-medium">{agent.successRate}%</span> success
            </div>
            <div className="text-[10px] text-zinc-500">
              <span className="text-zinc-300 font-medium">{agent.avgResponseTime}ms</span> avg
            </div>
            <div className="text-[10px] text-zinc-500">
              <span className="text-zinc-300 font-medium">{agent.uptime30d}%</span> uptime
            </div>
          </div>

          <div className="flex flex-wrap gap-1 mt-2">
            {agent.categories.map(cat => (
              <span key={cat} className="px-1.5 py-0.5 rounded text-[10px] bg-zinc-800 text-zinc-400">
                {cat}
              </span>
            ))}
          </div>
        </div>
      </div>
    </Link>
  );
}
