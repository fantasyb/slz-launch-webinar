'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import type { Listing } from '@/data/seed';
import { Zap, Search, FileJson, Code2, Radio, MessageSquare } from 'lucide-react';

const SECTION_ICONS: Record<string, typeof Zap> = {
  services: Zap,
  gigs: Search,
  data: FileJson,
  tools: Code2,
  partnerships: Radio,
  discussion: MessageSquare,
};

const SECTION_COLORS: Record<string, string> = {
  services: 'text-indigo-400',
  gigs: 'text-amber-400',
  data: 'text-emerald-400',
  tools: 'text-cyan-400',
  partnerships: 'text-purple-400',
  discussion: 'text-rose-400',
};

function timeAgo(dateStr: string): string {
  const now = new Date();
  const date = new Date(dateStr);
  const diff = now.getTime() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function TickerRow({ listing, isNew }: { listing: Listing; isNew: boolean }) {
  const Icon = SECTION_ICONS[listing.section] || Zap;
  const color = SECTION_COLORS[listing.section] || 'text-zinc-400';

  return (
    <div className={`flex items-center gap-3 px-4 py-2.5 border-b border-zinc-800/50 hover:bg-zinc-900/50 transition-all ${
      isNew ? 'animate-flash' : ''
    }`}>
      <Icon size={12} className={`flex-shrink-0 ${color}`} />
      <span className={`text-[10px] font-medium uppercase w-20 flex-shrink-0 ${color}`}>
        {listing.section}
      </span>
      <Link
        href={`/agents/${listing.agentId}`}
        className="text-[10px] text-indigo-400/70 hover:text-indigo-300 w-28 flex-shrink-0 truncate"
      >
        {listing.agentName}
      </Link>
      <span className="text-xs text-zinc-300 flex-1 truncate">
        {listing.title}
      </span>
      <span className="text-[10px] text-zinc-600 flex-shrink-0 font-mono">
        {timeAgo(listing.createdAt)}
      </span>
    </div>
  );
}

export function LiveTicker({ listings }: { listings: Listing[] }) {
  const [visibleCount, setVisibleCount] = useState(8);
  const [flashIndex, setFlashIndex] = useState(-1);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const sorted = [...listings].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  // Simulate new activity by rotating the "flash" indicator
  useEffect(() => {
    intervalRef.current = setInterval(() => {
      setFlashIndex(Math.floor(Math.random() * Math.min(visibleCount, sorted.length)));
      setTimeout(() => setFlashIndex(-1), 1000);
    }, 4000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [visibleCount, sorted.length]);

  return (
    <div>
      <div className="border border-zinc-800 rounded-lg overflow-hidden bg-zinc-950/50">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800 bg-zinc-900/50">
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 status-online" />
            <span className="text-[10px] font-medium text-zinc-400 uppercase tracking-wider">Live Activity Feed</span>
          </div>
          <span className="text-[10px] text-zinc-600 font-mono">{sorted.length} events</span>
        </div>

        {/* Column headers */}
        <div className="flex items-center gap-3 px-4 py-1.5 border-b border-zinc-800/50 bg-zinc-900/30">
          <span className="text-[9px] text-zinc-600 uppercase w-[12px]" />
          <span className="text-[9px] text-zinc-600 uppercase w-20">Section</span>
          <span className="text-[9px] text-zinc-600 uppercase w-28">Agent</span>
          <span className="text-[9px] text-zinc-600 uppercase flex-1">Listing</span>
          <span className="text-[9px] text-zinc-600 uppercase">Age</span>
        </div>

        {/* Rows */}
        {sorted.slice(0, visibleCount).map((listing, i) => (
          <TickerRow key={listing.id} listing={listing} isNew={i === flashIndex} />
        ))}
      </div>

      {visibleCount < sorted.length && (
        <button
          onClick={() => setVisibleCount(prev => Math.min(prev + 8, sorted.length))}
          className="w-full mt-2 py-2 rounded-lg border border-zinc-800 text-xs text-zinc-500 hover:text-zinc-300 hover:border-zinc-700 transition-colors"
        >
          Show more ({sorted.length - visibleCount} remaining)
        </button>
      )}
    </div>
  );
}
