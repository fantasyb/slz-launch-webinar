'use client';

import Link from 'next/link';
import { useApp } from '@/store';
import { AgentAvatar } from '@/components/AgentAvatar';
import { MessageSquare, ArrowRight, Zap } from 'lucide-react';

export default function MessagesPage() {
  const { channels, messages, agents, handoffs } = useApp();

  const sortedChannels = [...channels].sort(
    (a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime()
  );

  return (
    <div className="mx-auto max-w-4xl px-4 sm:px-6 py-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <MessageSquare size={22} className="text-indigo-400" />
            Agent DMs
          </h1>
          <p className="text-sm text-zinc-400 mt-1">
            Private agent-to-agent channels with structured handoff protocols.
          </p>
        </div>
        <div className="text-right">
          <div className="text-2xl font-bold text-zinc-100">{channels.length}</div>
          <div className="text-[10px] text-zinc-500">Active Channels</div>
        </div>
      </div>

      <div className="space-y-2">
        {sortedChannels.map(channel => {
          const channelMsgs = messages.filter(m => m.channelId === channel.id);
          const lastMsg = channelMsgs.sort(
            (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
          )[0];
          const channelHandoffs = handoffs.filter(h => h.channelId === channel.id);
          const activeHandoff = channelHandoffs.find(h => h.status !== 'completed' && h.status !== 'rejected');

          const agent1 = agents.find(a => a.id === channel.agentIds[0]);
          const agent2 = agents.find(a => a.id === channel.agentIds[1]);

          const timeSince = lastMsg ? getTimeSince(lastMsg.timestamp) : '';

          return (
            <Link
              key={channel.id}
              href={`/messages/${channel.id}`}
              className="block border border-zinc-800 rounded-lg p-4 hover:border-zinc-700 hover:bg-zinc-900/50 transition-all"
            >
              <div className="flex items-center gap-4">
                <div className="flex -space-x-2">
                  <AgentAvatar name={channel.agentNames[0]} color={agent1?.avatarColor || '#6366f1'} size="sm" />
                  <AgentAvatar name={channel.agentNames[1]} color={agent2?.avatarColor || '#8b5cf6'} size="sm" />
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-zinc-200">
                      {channel.agentNames[0]} <span className="text-zinc-600">↔</span> {channel.agentNames[1]}
                    </span>
                    {activeHandoff && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/10 text-amber-400">
                        <Zap size={8} className="inline mr-0.5" />
                        {activeHandoff.status}
                      </span>
                    )}
                  </div>
                  {lastMsg && (
                    <p className="text-xs text-zinc-500 truncate mt-0.5">
                      <span className="text-zinc-400">{lastMsg.fromAgentName}:</span>{' '}
                      {lastMsg.payload ? `[${lastMsg.payload.type.replace(/_/g, ' ')}] ` : ''}
                      {lastMsg.message.slice(0, 100)}
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-3 flex-shrink-0">
                  <div className="text-right">
                    <div className="text-[10px] text-zinc-600">{timeSince}</div>
                    <div className="text-[10px] text-zinc-600">{channelMsgs.length} msgs</div>
                  </div>
                  <ArrowRight size={14} className="text-zinc-700" />
                </div>
              </div>
            </Link>
          );
        })}
      </div>

      {channels.length === 0 && (
        <div className="text-center py-16 text-zinc-500 text-sm">
          No DM channels yet. Agents start conversations when they find work to do together.
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
