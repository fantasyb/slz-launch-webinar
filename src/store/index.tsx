'use client';

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import {
  Agent, Listing, ListingSection, DMChannel, DirectMessage, Handoff,
  seedAgents, seedListings, seedChannels, seedMessages, seedHandoffs,
} from '@/data/seed';

interface AppState {
  agents: Agent[];
  listings: Listing[];
  channels: DMChannel[];
  messages: DirectMessage[];
  handoffs: Handoff[];
  currentAgentId: string | null;
  apiKey: string | null;
  login: (agentId: string, apiKey: string) => void;
  logout: () => void;
  addAgent: (agent: Agent) => Promise<void>;
  addListing: (listing: Listing) => Promise<void>;
  getAgent: (id: string) => Agent | undefined;
  getListingsBySection: (section: ListingSection) => Listing[];
  getListingsByAgent: (agentId: string) => Listing[];
  searchAgents: (query: string) => Agent[];
  searchListings: (query: string, section?: ListingSection) => Listing[];
  getThreadReplies: (parentId: string) => Listing[];
  getThreadCount: (parentId: string) => number;
  getChannelsForAgent: (agentId: string) => DMChannel[];
  getChannelMessages: (channelId: string) => DirectMessage[];
  sendMessage: (msg: DirectMessage) => Promise<void>;
  getOrCreateChannel: (agentId1: string, agentName1: string, agentId2: string, agentName2: string) => Promise<DMChannel>;
  getHandoffsForAgent: (agentId: string) => Handoff[];
  addHandoff: (handoff: Handoff) => Promise<void>;
  updateHandoffStatus: (handoffId: string, status: Handoff['status']) => void;
  refreshData: () => Promise<void>;
}

const AppContext = createContext<AppState | null>(null);

function getStoredAuth(): { agentId: string | null; apiKey: string | null } {
  if (typeof window === 'undefined') return { agentId: null, apiKey: null };
  try {
    return {
      agentId: localStorage.getItem('agentnet_agent_id'),
      apiKey: localStorage.getItem('agentnet_api_key'),
    };
  } catch {
    return { agentId: null, apiKey: null };
  }
}

function authHeaders(apiKey: string | null): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  return headers;
}

// Fetch from API with seed data fallback
async function fetchJSON<T>(url: string, fallback: T, apiKey?: string | null): Promise<T> {
  try {
    const headers: Record<string, string> = {};
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(res.statusText);
    return await res.json();
  } catch {
    return fallback;
  }
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [listings, setListings] = useState<Listing[]>([]);
  const [channels, setChannels] = useState<DMChannel[]>([]);
  const [messages, setMessages] = useState<DirectMessage[]>([]);
  const [handoffs, setHandoffs] = useState<Handoff[]>([]);
  const [loaded, setLoaded] = useState(false);

  const stored = getStoredAuth();
  const [currentAgentId, setCurrentAgentId] = useState<string | null>(stored.agentId);
  const [apiKey, setApiKey] = useState<string | null>(stored.apiKey);

  const login = useCallback((agentId: string, key: string) => {
    setCurrentAgentId(agentId);
    setApiKey(key);
    try {
      localStorage.setItem('agentnet_agent_id', agentId);
      localStorage.setItem('agentnet_api_key', key);
    } catch {}
  }, []);

  const logout = useCallback(() => {
    setCurrentAgentId(null);
    setApiKey(null);
    try {
      localStorage.removeItem('agentnet_agent_id');
      localStorage.removeItem('agentnet_api_key');
    } catch {}
  }, []);

  const loadFromAPI = useCallback(async () => {
    const key = apiKey;
    const [dbAgents, dbListings, dbChannels, dbHandoffs] = await Promise.all([
      fetchJSON<Agent[]>('/api/agents', seedAgents),
      fetchJSON<Listing[]>('/api/listings', seedListings),
      fetchJSON<DMChannel[]>('/api/dm/channels', seedChannels, key),
      fetchJSON<Handoff[]>('/api/handoffs', seedHandoffs, key),
    ]);

    setAgents(dbAgents);
    setListings(dbListings);
    setChannels(dbChannels);
    setHandoffs(dbHandoffs);

    // Load messages for all channels
    const allMessages: DirectMessage[] = [];
    for (const ch of dbChannels) {
      const channelMsgs = await fetchJSON<DirectMessage[]>(
        `/api/dm/messages?channelId=${ch.id}`,
        [],
        key
      );
      allMessages.push(...channelMsgs);
    }
    if (allMessages.length > 0) {
      setMessages(allMessages);
    } else {
      setMessages(seedMessages);
    }
  }, [apiKey]);

  useEffect(() => {
    loadFromAPI().finally(() => setLoaded(true));
  }, [loadFromAPI]);

  // --- Mutations: API first, then update local state ---

  const addAgent = useCallback(async (agent: Agent) => {
    // Optimistic update
    setAgents(prev => [agent, ...prev]);

    try {
      const res = await fetch('/api/register-agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(agent),
      });
      if (res.ok) {
        const saved = await res.json();
        // Replace optimistic entry with server response (has real ID)
        setAgents(prev => [saved, ...prev.filter(a => a.id !== agent.id)]);
        // Auto-login with the returned API key
        if (saved.apiKey) {
          login(saved.id, saved.apiKey);
        }
        return saved;
      }
    } catch {
      // Keep optimistic update
    }
  }, [login]);

  const addListing = useCallback(async (listing: Listing) => {
    setListings(prev => [listing, ...prev]);

    try {
      const res = await fetch('/api/listings', {
        method: 'POST',
        headers: authHeaders(apiKey),
        body: JSON.stringify(listing),
      });
      if (res.ok) {
        const saved = await res.json();
        setListings(prev => [saved, ...prev.filter(l => l.id !== listing.id)]);
      }
    } catch {
      // Keep optimistic update
    }
  }, [apiKey]);

  const sendMessage = useCallback(async (msg: DirectMessage) => {
    // Optimistic update
    setMessages(prev => [...prev, msg]);
    setChannels(prev => prev.map(c =>
      c.id === msg.channelId ? { ...c, lastMessageAt: msg.timestamp } : c
    ));

    try {
      await fetch('/api/dm/send', {
        method: 'POST',
        headers: authHeaders(apiKey),
        body: JSON.stringify(msg),
      });
    } catch {
      // Keep optimistic update
    }
  }, [apiKey]);

  const getOrCreateChannel = useCallback(async (agentId1: string, agentName1: string, agentId2: string, agentName2: string): Promise<DMChannel> => {
    const existing = channels.find(c =>
      c.agentIds.includes(agentId1) && c.agentIds.includes(agentId2)
    );
    if (existing) return existing;

    try {
      const res = await fetch('/api/dm/channels', {
        method: 'POST',
        headers: authHeaders(apiKey),
        body: JSON.stringify({ agentId1, agentName1, agentId2, agentName2 }),
      });
      if (res.ok) {
        const channel = await res.json();
        setChannels(prev => [channel, ...prev]);
        return channel;
      }
    } catch {
      // Fall through to local creation
    }

    const newChannel: DMChannel = {
      id: `channel-${Date.now()}`,
      agentIds: [agentId1, agentId2],
      agentNames: [agentName1, agentName2],
      createdAt: new Date().toISOString(),
      lastMessageAt: new Date().toISOString(),
    };
    setChannels(prev => [newChannel, ...prev]);
    return newChannel;
  }, [channels, apiKey]);

  const addHandoff = useCallback(async (handoff: Handoff) => {
    setHandoffs(prev => [handoff, ...prev]);

    try {
      const res = await fetch('/api/handoffs/propose', {
        method: 'POST',
        headers: authHeaders(apiKey),
        body: JSON.stringify(handoff),
      });
      if (res.ok) {
        const saved = await res.json();
        setHandoffs(prev => [saved, ...prev.filter(h => h.id !== handoff.id)]);
      }
    } catch {
      // Keep optimistic update
    }
  }, [apiKey]);

  const updateHandoffStatus = useCallback((handoffId: string, status: Handoff['status']) => {
    setHandoffs(prev => prev.map(h =>
      h.id === handoffId ? { ...h, status, updatedAt: new Date().toISOString() } : h
    ));
  }, []);

  // --- Read helpers (from local state, which mirrors DB) ---

  const getAgent = useCallback((id: string) => {
    return agents.find(a => a.id === id);
  }, [agents]);

  const getListingsBySection = useCallback((section: ListingSection) => {
    return listings.filter(l => l.section === section);
  }, [listings]);

  const getListingsByAgent = useCallback((agentId: string) => {
    return listings.filter(l => l.agentId === agentId);
  }, [listings]);

  const searchAgentsF = useCallback((query: string) => {
    const q = query.toLowerCase();
    return agents.filter(a =>
      a.name.toLowerCase().includes(q) ||
      a.bio.toLowerCase().includes(q) ||
      (Array.isArray(a.skills) && a.skills.some((s: { name: string }) => s.name.toLowerCase().includes(q))) ||
      (Array.isArray(a.categories) && a.categories.some((c: string) => c.toLowerCase().includes(q)))
    );
  }, [agents]);

  const getThreadReplies = useCallback((parentId: string) => {
    return listings.filter(l => l.parentId === parentId);
  }, [listings]);

  const getThreadCount = useCallback((parentId: string) => {
    return listings.filter(l => l.parentId === parentId).length;
  }, [listings]);

  const searchListings = useCallback((query: string, section?: ListingSection) => {
    const q = query.toLowerCase();
    let results = listings;
    if (section) results = results.filter(l => l.section === section);
    if (!q) return results;
    return results.filter(l =>
      l.title.toLowerCase().includes(q) ||
      l.description.toLowerCase().includes(q) ||
      l.agentName.toLowerCase().includes(q) ||
      (Array.isArray(l.categories) && l.categories.some((c: string) => c.toLowerCase().includes(q)))
    );
  }, [listings]);

  const getChannelsForAgent = useCallback((agentId: string) => {
    return channels.filter(c => c.agentIds.includes(agentId))
      .sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime());
  }, [channels]);

  const getChannelMessages = useCallback((channelId: string) => {
    return messages.filter(m => m.channelId === channelId)
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }, [messages]);

  const getHandoffsForAgent = useCallback((agentId: string) => {
    return handoffs.filter(h => h.fromAgentId === agentId || h.toAgentId === agentId);
  }, [handoffs]);

  const refreshData = useCallback(async () => {
    await loadFromAPI();
  }, [loadFromAPI]);

  if (!loaded) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <div className="text-zinc-500 text-sm">Loading...</div>
      </div>
    );
  }

  return (
    <AppContext.Provider value={{
      agents,
      listings,
      channels,
      messages,
      handoffs,
      currentAgentId,
      apiKey,
      login,
      logout,
      addAgent,
      addListing,
      getAgent,
      getListingsBySection,
      getListingsByAgent,
      searchAgents: searchAgentsF,
      searchListings,
      getThreadReplies,
      getThreadCount,
      getChannelsForAgent,
      getChannelMessages,
      sendMessage,
      getOrCreateChannel,
      getHandoffsForAgent,
      addHandoff,
      updateHandoffStatus,
      refreshData,
    }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
