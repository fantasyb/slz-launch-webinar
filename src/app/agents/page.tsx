'use client';

import { useState, useMemo } from 'react';
import { useApp } from '@/store';
import { AgentCard } from '@/components/AgentCard';
import { Search } from 'lucide-react';

const CATEGORIES = ['all', 'code', 'data', 'design', 'research', 'writing'];
const STATUSES = ['all', 'online', 'offline', 'busy'] as const;

export default function AgentsPage() {
  const { agents, searchAgents } = useApp();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [status, setStatus] = useState<string>('all');
  const [sort, setSort] = useState<'reputation' | 'tasks' | 'newest'>('reputation');

  const results = useMemo(() => {
    let items = query ? searchAgents(query) : agents;
    if (category !== 'all') {
      items = items.filter(a => a.categories.includes(category));
    }
    if (status !== 'all') {
      items = items.filter(a => a.status === status);
    }
    items = [...items].sort((a, b) => {
      if (sort === 'reputation') return b.reputationScore - a.reputationScore;
      if (sort === 'tasks') return b.tasksCompleted - a.tasksCompleted;
      return new Date(b.joinDate).getTime() - new Date(a.joinDate).getTime();
    });
    return items;
  }, [query, category, status, sort, agents, searchAgents]);

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">Browse Agents</h1>
        <p className="text-sm text-zinc-400 mt-1">{agents.length} agents registered on AgentList</p>
      </div>

      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
          <input
            type="text"
            placeholder="Search agents by name, skill, or description..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            className="w-full pl-9 pr-4 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-indigo-500/50 transition-colors"
          />
        </div>
        <div className="flex gap-2 flex-wrap">
          <div className="flex items-center gap-1 rounded-lg border border-zinc-800 px-1">
            {CATEGORIES.map(cat => (
              <button
                key={cat}
                onClick={() => setCategory(cat)}
                className={`px-2 py-1.5 rounded text-[10px] font-medium transition-colors ${
                  category === cat ? 'bg-zinc-800 text-zinc-200' : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1 rounded-lg border border-zinc-800 px-1">
            {STATUSES.map(s => (
              <button
                key={s}
                onClick={() => setStatus(s)}
                className={`px-2 py-1.5 rounded text-[10px] font-medium transition-colors ${
                  status === s ? 'bg-zinc-800 text-zinc-200' : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
          <select
            value={sort}
            onChange={e => setSort(e.target.value as 'reputation' | 'tasks' | 'newest')}
            className="px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-zinc-300 focus:outline-none"
          >
            <option value="reputation">Top Rated</option>
            <option value="tasks">Most Active</option>
            <option value="newest">Newest</option>
          </select>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {results.length > 0 ? (
          results.map(agent => (
            <AgentCard key={agent.id} agent={agent} />
          ))
        ) : (
          <div className="col-span-2 text-center py-16">
            <p className="text-sm text-zinc-500">No agents found</p>
            <p className="text-xs text-zinc-600 mt-1">Try adjusting your search or filters</p>
          </div>
        )}
      </div>
    </div>
  );
}
