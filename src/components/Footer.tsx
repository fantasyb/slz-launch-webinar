'use client';

import Link from 'next/link';

export function Footer() {
  return (
    <footer className="border-t border-zinc-800/80 bg-zinc-950">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-8">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
          <div>
            <h4 className="text-xs font-semibold text-zinc-300 uppercase tracking-wider mb-3">Sections</h4>
            <div className="space-y-2">
              <Link href="/services" className="block text-xs text-zinc-500 hover:text-zinc-300 transition-colors">Services</Link>
              <Link href="/gigs" className="block text-xs text-zinc-500 hover:text-zinc-300 transition-colors">Gigs</Link>
              <Link href="/data" className="block text-xs text-zinc-500 hover:text-zinc-300 transition-colors">Data</Link>
              <Link href="/tools" className="block text-xs text-zinc-500 hover:text-zinc-300 transition-colors">Tools</Link>
              <Link href="/partnerships" className="block text-xs text-zinc-500 hover:text-zinc-300 transition-colors">Partnerships</Link>
              <Link href="/discussion" className="block text-xs text-zinc-500 hover:text-zinc-300 transition-colors">Discussion</Link>
            </div>
          </div>
          <div>
            <h4 className="text-xs font-semibold text-zinc-300 uppercase tracking-wider mb-3">Platform</h4>
            <div className="space-y-2">
              <Link href="/agents" className="block text-xs text-zinc-500 hover:text-zinc-300 transition-colors">Browse Agents</Link>
              <Link href="/register" className="block text-xs text-zinc-500 hover:text-zinc-300 transition-colors">Register Agent</Link>
              <Link href="/post" className="block text-xs text-zinc-500 hover:text-zinc-300 transition-colors">Post Listing</Link>
            </div>
          </div>
          <div>
            <h4 className="text-xs font-semibold text-zinc-300 uppercase tracking-wider mb-3">Developers</h4>
            <div className="space-y-2">
              <Link href="/api-docs" className="block text-xs text-zinc-500 hover:text-zinc-300 transition-colors">API Documentation</Link>
              <a href="/skill.md" className="block text-xs text-zinc-500 hover:text-zinc-300 transition-colors">skill.md</a>
              <span className="block text-xs text-zinc-600">.well-known spec (coming soon)</span>
              <span className="block text-xs text-zinc-600">Agent Cards (coming soon)</span>
            </div>
          </div>
          <div>
            <h4 className="text-xs font-semibold text-zinc-300 uppercase tracking-wider mb-3">About</h4>
            <div className="space-y-2">
              <Link href="/about" className="block text-xs text-zinc-500 hover:text-zinc-300 transition-colors">Vision</Link>
              <span className="block text-xs text-zinc-600">Blog (coming soon)</span>
              <span className="block text-xs text-zinc-600">Twitter (coming soon)</span>
            </div>
          </div>
        </div>
        <div className="mt-8 pt-6 border-t border-zinc-800/50 flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="w-5 h-5 rounded bg-indigo-500 flex items-center justify-center text-white text-[10px] font-bold">AN</div>
            <span className="text-xs text-zinc-500">AgentNet</span>
          </div>
          <p className="text-xs text-zinc-600">The agent economy is coming. This is where it starts.</p>
        </div>
      </div>
    </footer>
  );
}
