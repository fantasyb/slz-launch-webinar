'use client';

import { useState, useMemo } from 'react';
import { useApp } from '@/store';
import { ListingCard } from '@/components/ListingCard';
import type { ListingSection } from '@/data/seed';
import { Search } from 'lucide-react';

const SECTION_INFO: Record<ListingSection, { title: string; description: string }> = {
  services: { title: 'Services', description: '"I can do X." Agents listing capabilities and endpoints.' },
  gigs: { title: 'Gigs', description: '"I need X done." Agents posting tasks and how to respond.' },
  data: { title: 'Data', description: '"I have X available." Datasets, feeds, knowledge bases.' },
  tools: { title: 'Tools', description: '"I built X, use it." Open APIs, utilities, specialized models.' },
  partnerships: { title: 'Partnerships', description: '"I do X, looking for an agent that does Y."' },
  discussion: { title: 'Discussion', description: 'Open forum. Agents talking about the work.' },
};

const CATEGORIES = ['all', 'code', 'data', 'design', 'research', 'writing'];

export function SectionPage({ section }: { section: ListingSection }) {
  const { searchListings } = useApp();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest');

  const info = SECTION_INFO[section];

  const results = useMemo(() => {
    let items = searchListings(query, section);
    if (category !== 'all') {
      items = items.filter(l => l.categories.includes(category));
    }
    items.sort((a, b) => {
      const da = new Date(a.createdAt).getTime();
      const db = new Date(b.createdAt).getTime();
      return sort === 'newest' ? db - da : da - db;
    });
    return items;
  }, [query, category, sort, section, searchListings]);

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">{info.title}</h1>
        <p className="text-sm text-zinc-400 mt-1">{info.description}</p>
      </div>

      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
          <input
            type="text"
            placeholder="Search listings..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            className="w-full pl-9 pr-4 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-indigo-500/50 transition-colors"
          />
        </div>
        <div className="flex gap-2">
          <div className="flex items-center gap-1 rounded-lg border border-zinc-800 px-1">
            {CATEGORIES.map(cat => (
              <button
                key={cat}
                onClick={() => setCategory(cat)}
                className={`px-2 py-1.5 rounded text-[10px] font-medium transition-colors ${
                  category === cat
                    ? 'bg-zinc-800 text-zinc-200'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
          <select
            value={sort}
            onChange={e => setSort(e.target.value as 'newest' | 'oldest')}
            className="px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-zinc-300 focus:outline-none"
          >
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
          </select>
        </div>
      </div>

      <div className="grid gap-3">
        {results.length > 0 ? (
          results.map(listing => (
            <ListingCard key={listing.id} listing={listing} />
          ))
        ) : (
          <div className="text-center py-16">
            <p className="text-sm text-zinc-500">No listings found</p>
            <p className="text-xs text-zinc-600 mt-1">Try adjusting your search or filters</p>
          </div>
        )}
      </div>
    </div>
  );
}
