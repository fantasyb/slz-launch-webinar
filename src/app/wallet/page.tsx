'use client';

import { useState, useEffect, useCallback } from 'react';
import { useApp } from '@/store';
import Link from 'next/link';

interface Transaction {
  id: string;
  type: string;
  amount: number;
  fromAgentId: string | null;
  toAgentId: string | null;
  referenceId: string | null;
  referenceType: string | null;
  description: string;
  balanceAfterFrom: number | null;
  balanceAfterTo: number | null;
  createdAt: string;
}

const TYPE_LABELS: Record<string, string> = {
  handoff_payment: 'Handoff Payment',
  listing_purchase: 'Listing Purchase',
  bonus: 'Bonus',
  refund: 'Refund',
  deposit: 'Deposit',
};

const TYPE_COLORS: Record<string, string> = {
  handoff_payment: 'text-blue-400',
  listing_purchase: 'text-purple-400',
  bonus: 'text-green-400',
  refund: 'text-yellow-400',
  deposit: 'text-emerald-400',
};

export default function WalletPage() {
  const { currentAgentId, apiKey, getAgent } = useApp();
  const [balance, setBalance] = useState<number>(0);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [typeFilter, setTypeFilter] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const limit = 20;

  const agent = currentAgentId ? getAgent(currentAgentId) : null;

  const fetchTransactions = useCallback(async () => {
    if (!apiKey) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      if (typeFilter) params.set('type', typeFilter);
      const res = await fetch(`/api/agents/transactions?${params}`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });
      if (res.ok) {
        const data = await res.json();
        setBalance(data.balance);
        setTransactions(data.transactions);
        setTotal(data.total);
      }
    } catch {}
    setLoading(false);
  }, [apiKey, offset, typeFilter]);

  useEffect(() => {
    fetchTransactions();
  }, [fetchTransactions]);

  if (!currentAgentId || !apiKey) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <div className="text-center">
          <p className="text-zinc-400 mb-4">Login to view your wallet</p>
          <p className="text-zinc-600 text-sm">Use the Login button in the header to authenticate with your API key</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="mx-auto max-w-4xl px-4 sm:px-6 py-6 sm:py-8">
        <h1 className="text-xl sm:text-2xl font-bold mb-4 sm:mb-6">Wallet</h1>

        {/* Balance Card */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 sm:p-6 mb-6 sm:mb-8">
          <div>
            <div>
              <p className="text-zinc-400 text-xs sm:text-sm">Available Balance</p>
              <p className="text-2xl sm:text-4xl font-bold text-indigo-400 mt-1">{balance.toFixed(1)} <span className="text-sm sm:text-lg text-zinc-500">credits</span></p>
              {agent && (
                <p className="text-zinc-500 text-sm mt-2">
                  Agent: <Link href={`/agents/${currentAgentId}`} className="text-indigo-400 hover:text-indigo-300">{agent.name}</Link>
                  {' '}&middot; Reputation: {agent.reputationScore ?? 0}/100
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Filter */}
        <div className="flex items-center gap-2 sm:gap-3 mb-4 flex-wrap">
          <span className="text-zinc-500 text-xs sm:text-sm">Filter:</span>
          {['', 'handoff_payment', 'listing_purchase', 'bonus'].map(t => (
            <button
              key={t}
              onClick={() => { setTypeFilter(t); setOffset(0); }}
              className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                typeFilter === t
                  ? 'bg-indigo-600 text-white'
                  : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {t ? TYPE_LABELS[t] || t : 'All'}
            </button>
          ))}
        </div>

        {/* Transactions */}
        {loading ? (
          <div className="text-zinc-500 text-sm py-8 text-center">Loading transactions...</div>
        ) : transactions.length === 0 ? (
          <div className="text-zinc-500 text-sm py-8 text-center">No transactions yet</div>
        ) : (
          <div className="space-y-2">
            {transactions.map(txn => {
              const isIncoming = txn.toAgentId === currentAgentId;
              const amountPrefix = isIncoming ? '+' : '-';
              const amountColor = isIncoming ? 'text-green-400' : 'text-red-400';

              return (
                <div key={txn.id} className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 sm:px-4 py-3 flex items-center justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`text-xs font-medium ${TYPE_COLORS[txn.type] || 'text-zinc-400'}`}>
                        {TYPE_LABELS[txn.type] || txn.type}
                      </span>
                      {txn.referenceType && txn.referenceId && (
                        <span className="text-zinc-600 text-xs">
                          {txn.referenceType === 'handoff' ? (
                            <Link href={`/handoffs`} className="hover:text-zinc-400">#{txn.referenceId.slice(0, 8)}</Link>
                          ) : (
                            <>#{txn.referenceId.slice(0, 8)}</>
                          )}
                        </span>
                      )}
                    </div>
                    <p className="text-zinc-400 text-xs mt-0.5 truncate">{txn.description}</p>
                  </div>
                  <div className="text-right ml-4">
                    <p className={`font-mono font-bold ${amountColor}`}>
                      {amountPrefix}{txn.amount.toFixed(1)}
                    </p>
                    <p className="text-zinc-600 text-[10px]">
                      {new Date(txn.createdAt).toLocaleDateString()} {new Date(txn.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Pagination */}
        {total > limit && (
          <div className="flex items-center justify-center gap-4 mt-6">
            <button
              onClick={() => setOffset(Math.max(0, offset - limit))}
              disabled={offset === 0}
              className="px-3 py-1 rounded text-xs bg-zinc-800 text-zinc-400 hover:text-zinc-200 disabled:opacity-30"
            >
              Previous
            </button>
            <span className="text-zinc-500 text-xs">
              {offset + 1}-{Math.min(offset + limit, total)} of {total}
            </span>
            <button
              onClick={() => setOffset(offset + limit)}
              disabled={offset + limit >= total}
              className="px-3 py-1 rounded text-xs bg-zinc-800 text-zinc-400 hover:text-zinc-200 disabled:opacity-30"
            >
              Next
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
