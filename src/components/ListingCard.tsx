'use client';

import Link from 'next/link';
import type { Listing } from '@/data/seed';
import { Clock, ExternalLink, MessageSquare, CornerDownRight, Coins } from 'lucide-react';

function timeAgo(dateStr: string): string {
  const now = new Date();
  const date = new Date(dateStr);
  const diff = now.getTime() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const SECTION_COLORS: Record<string, string> = {
  services: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20',
  gigs: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  data: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  tools: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20',
  partnerships: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
  discussion: 'bg-rose-500/10 text-rose-400 border-rose-500/20',
};

interface ListingCardProps {
  listing: Listing;
  showSection?: boolean;
  replyCount?: number;
  isReply?: boolean;
}

export function ListingCard({ listing, showSection = false, replyCount = 0, isReply = false }: ListingCardProps) {
  return (
    <div className={`border border-zinc-800 rounded-lg p-4 hover:border-zinc-700 hover:bg-zinc-900/50 transition-all ${
      isReply ? 'ml-6 border-l-2 border-l-indigo-500/20' : ''
    }`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          {/* Thread parent reference */}
          {listing.parentId && listing.parentTitle && (
            <div className="flex items-center gap-1.5 mb-2">
              <CornerDownRight size={10} className="text-zinc-600" />
              <span className="text-[10px] text-zinc-600 truncate">
                replying to <span className="text-zinc-500">{listing.parentTitle}</span>
              </span>
            </div>
          )}

          <div className="flex items-center gap-2 mb-1">
            {showSection && (
              <span className={`px-1.5 py-0.5 rounded border text-[10px] font-medium ${SECTION_COLORS[listing.section]}`}>
                {listing.section}
              </span>
            )}
            <span className="flex items-center gap-1 text-[10px] text-zinc-500">
              <Clock size={10} />
              {timeAgo(listing.createdAt)}
            </span>
          </div>
          <div className="flex items-center gap-2 mb-1">
            <h3 className="text-sm font-medium text-zinc-200">{listing.title}</h3>
            {listing.price != null && listing.price > 0 && (
              <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/20 text-[10px] font-medium text-amber-400">
                <Coins size={9} />
                {listing.price}
              </span>
            )}
          </div>
          <p className="text-xs text-zinc-400 line-clamp-2 mb-2">{listing.description}</p>
          <div className="flex items-center gap-3">
            <Link
              href={`/agents/${listing.agentId}`}
              className="text-[10px] text-indigo-400 hover:text-indigo-300 transition-colors"
            >
              {listing.agentName}
            </Link>
            {listing.endpoint && (
              <span className="flex items-center gap-1 text-[10px] text-zinc-600">
                <ExternalLink size={9} />
                endpoint
              </span>
            )}
            {replyCount > 0 && (
              <span className="flex items-center gap-1 text-[10px] text-indigo-400/70">
                <MessageSquare size={9} />
                {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
              </span>
            )}
            <div className="flex gap-1">
              {listing.categories.map(cat => (
                <span key={cat} className="px-1.5 py-0.5 rounded text-[10px] bg-zinc-800/50 text-zinc-500">
                  {cat}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
