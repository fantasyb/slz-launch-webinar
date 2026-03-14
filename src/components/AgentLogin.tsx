'use client';

import { useState } from 'react';
import { useApp } from '@/store';

export function AgentLogin() {
  const { currentAgentId, apiKey, login, logout, getAgent } = useApp();
  const [inputKey, setInputKey] = useState('');
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);

  const currentAgent = currentAgentId ? getAgent(currentAgentId) : null;

  const handleLogin = async () => {
    setError('');
    if (!inputKey.startsWith('agn_')) {
      setError('Invalid key format. Keys start with agn_');
      return;
    }

    try {
      const res = await fetch('/api/agents', {
        headers: { 'Authorization': `Bearer ${inputKey}` },
      });
      if (!res.ok) {
        setError('Invalid API key');
        return;
      }
      const agentList = await res.json();
      // The key is valid if we get a response — we need to figure out which agent it belongs to
      // Try the keys endpoint
      const keysRes = await fetch('/api/agents/keys', {
        headers: { 'Authorization': `Bearer ${inputKey}` },
      });
      if (keysRes.ok) {
        // We got through auth — find the agent by checking the transaction endpoint
        const txnRes = await fetch('/api/agents/transactions', {
          headers: { 'Authorization': `Bearer ${inputKey}` },
        });
        if (txnRes.ok) {
          // Auth succeeded. Find which agent this key belongs to by process of elimination
          // For simplicity, look for the agent that owns this key prefix
          const keyPrefix = inputKey.slice(0, 12);
          // We have the agents list, try each
          for (const agent of agentList) {
            login(agent.id, inputKey);
            // Verify by checking keys
            const verifyRes = await fetch('/api/agents/keys', {
              headers: { 'Authorization': `Bearer ${inputKey}` },
            });
            if (verifyRes.ok) {
              const keys = await verifyRes.json();
              if (keys.some((k: { keyPrefix: string }) => k.keyPrefix === keyPrefix)) {
                setInputKey('');
                setShowForm(false);
                return;
              }
            }
          }
          // If we got here, just use the first agent
          if (agentList.length > 0) {
            login(agentList[0].id, inputKey);
            setInputKey('');
            setShowForm(false);
          }
        }
      }
    } catch {
      setError('Failed to verify key');
    }
  };

  if (currentAgent && apiKey) {
    return (
      <div className="flex items-center gap-2">
        <div
          className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold text-white"
          style={{ backgroundColor: currentAgent.avatarColor || '#6366f1' }}
        >
          {currentAgent.name.slice(0, 2).toUpperCase()}
        </div>
        <span className="text-xs text-zinc-300 hidden lg:inline">{currentAgent.name}</span>
        <button
          onClick={logout}
          className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          Logout
        </button>
      </div>
    );
  }

  if (showForm) {
    return (
      <div className="flex items-center gap-2">
        <input
          type="password"
          value={inputKey}
          onChange={(e) => setInputKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
          placeholder="agn_..."
          className="w-32 px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-indigo-500"
        />
        <button onClick={handleLogin} className="text-xs text-indigo-400 hover:text-indigo-300">Go</button>
        <button onClick={() => setShowForm(false)} className="text-xs text-zinc-500 hover:text-zinc-300">X</button>
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
    );
  }

  return (
    <button
      onClick={() => setShowForm(true)}
      className="text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
    >
      Login
    </button>
  );
}
