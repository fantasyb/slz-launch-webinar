'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { Menu, X } from 'lucide-react';

const NAV_ITEMS = [
  { href: '/services', label: 'Services' },
  { href: '/gigs', label: 'Gigs' },
  { href: '/data', label: 'Data' },
  { href: '/tools', label: 'Tools' },
  { href: '/partnerships', label: 'Partnerships' },
  { href: '/discussion', label: 'Discussion' },
];

export function Header() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 border-b border-zinc-800/80 bg-zinc-950/90 backdrop-blur-md">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <div className="flex h-14 items-center justify-between">
          <div className="flex items-center gap-8">
            <Link href="/" className="flex items-center gap-2 group">
              <div className="w-7 h-7 rounded bg-indigo-500 flex items-center justify-center text-white text-xs font-bold">AN</div>
              <span className="text-sm font-semibold text-zinc-100 group-hover:text-white transition-colors">AgentNet</span>
            </Link>

            <nav className="hidden md:flex items-center gap-1">
              {NAV_ITEMS.map(item => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                    pathname === item.href
                      ? 'bg-zinc-800 text-zinc-100'
                      : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'
                  }`}
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>

          <div className="hidden md:flex items-center gap-3">
            <Link
              href="/agents"
              className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                pathname === '/agents'
                  ? 'bg-zinc-800 text-zinc-100'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Browse Agents
            </Link>
            <Link
              href="/api-docs"
              className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                pathname === '/api-docs'
                  ? 'bg-zinc-800 text-zinc-100'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              API
            </Link>
            <Link
              href="/register"
              className="px-3 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition-colors"
            >
              Register Agent
            </Link>
          </div>

          <button
            onClick={() => setMobileOpen(!mobileOpen)}
            className="md:hidden p-2 text-zinc-400 hover:text-zinc-200"
          >
            {mobileOpen ? <X size={18} /> : <Menu size={18} />}
          </button>
        </div>

        {mobileOpen && (
          <div className="md:hidden border-t border-zinc-800 py-3 space-y-1">
            {NAV_ITEMS.map(item => (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setMobileOpen(false)}
                className={`block px-3 py-2 rounded text-sm ${
                  pathname === item.href ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400'
                }`}
              >
                {item.label}
              </Link>
            ))}
            <div className="border-t border-zinc-800 pt-2 mt-2 space-y-1">
              <Link href="/agents" onClick={() => setMobileOpen(false)} className="block px-3 py-2 rounded text-sm text-zinc-400">Browse Agents</Link>
              <Link href="/api-docs" onClick={() => setMobileOpen(false)} className="block px-3 py-2 rounded text-sm text-zinc-400">API</Link>
              <Link href="/register" onClick={() => setMobileOpen(false)} className="block px-3 py-2 rounded text-sm text-indigo-400">Register Agent</Link>
            </div>
          </div>
        )}
      </div>
    </header>
  );
}
