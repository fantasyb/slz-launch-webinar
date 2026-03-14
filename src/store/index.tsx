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
  addAgent: (agent: Agent) => void;
  addListing: (listing: Listing) => void;
  getAgent: (id: string) => Agent | undefined;
  getListingsBySection: (section: ListingSection) => Listing[];
  getListingsByAgent: (agentId: string) => Listing[];
  searchAgents: (query: string) => Agent[];
  searchListings: (query: string, section?: ListingSection) => Listing[];
  getThreadReplies: (parentId: string) => Listing[];
  getThreadCount: (parentId: string) => number;
  getChannelsForAgent: (agentId: string) => DMChannel[];
  getChannelMessages: (channelId: string) => DirectMessage[];
  sendMessage: (msg: DirectMessage) => void;
  getOrCreateChannel: (agentId1: string, agentName1: string, agentId2: string, agentName2: string) => DMChannel;
  getHandoffsForAgent: (agentId: string) => Handoff[];
  addHandoff: (handoff: Handoff) => void;
  updateHandoffStatus: (handoffId: string, status: Handoff['status']) => void;
}

const AppContext = createContext<AppState | null>(null);

const STORAGE_KEY_AGENTS = 'agentlist_agents';
const STORAGE_KEY_LISTINGS = 'agentlist_listings';
const STORAGE_KEY_CHANNELS = 'agentnet_channels';
const STORAGE_KEY_MESSAGES = 'agentnet_messages';
const STORAGE_KEY_HANDOFFS = 'agentnet_handoffs';

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [listings, setListings] = useState<Listing[]>([]);
  const [channels, setChannels] = useState<DMChannel[]>([]);
  const [messages, setMessages] = useState<DirectMessage[]>([]);
  const [handoffs, setHandoffs] = useState<Handoff[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    try {
      const storedAgents = localStorage.getItem(STORAGE_KEY_AGENTS);
      const storedListings = localStorage.getItem(STORAGE_KEY_LISTINGS);
      const storedChannels = localStorage.getItem(STORAGE_KEY_CHANNELS);
      const storedMessages = localStorage.getItem(STORAGE_KEY_MESSAGES);
      const storedHandoffs = localStorage.getItem(STORAGE_KEY_HANDOFFS);

      if (storedAgents && storedListings) {
        setAgents(JSON.parse(storedAgents));
        setListings(JSON.parse(storedListings));
      } else {
        setAgents(seedAgents);
        setListings(seedListings);
        localStorage.setItem(STORAGE_KEY_AGENTS, JSON.stringify(seedAgents));
        localStorage.setItem(STORAGE_KEY_LISTINGS, JSON.stringify(seedListings));
      }

      if (storedChannels && storedMessages && storedHandoffs) {
        setChannels(JSON.parse(storedChannels));
        setMessages(JSON.parse(storedMessages));
        setHandoffs(JSON.parse(storedHandoffs));
      } else {
        setChannels(seedChannels);
        setMessages(seedMessages);
        setHandoffs(seedHandoffs);
        localStorage.setItem(STORAGE_KEY_CHANNELS, JSON.stringify(seedChannels));
        localStorage.setItem(STORAGE_KEY_MESSAGES, JSON.stringify(seedMessages));
        localStorage.setItem(STORAGE_KEY_HANDOFFS, JSON.stringify(seedHandoffs));
      }
    } catch {
      setAgents(seedAgents);
      setListings(seedListings);
      setChannels(seedChannels);
      setMessages(seedMessages);
      setHandoffs(seedHandoffs);
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (loaded) {
      localStorage.setItem(STORAGE_KEY_AGENTS, JSON.stringify(agents));
    }
  }, [agents, loaded]);

  useEffect(() => {
    if (loaded) {
      localStorage.setItem(STORAGE_KEY_LISTINGS, JSON.stringify(listings));
    }
  }, [listings, loaded]);

  useEffect(() => {
    if (loaded) {
      localStorage.setItem(STORAGE_KEY_CHANNELS, JSON.stringify(channels));
    }
  }, [channels, loaded]);

  useEffect(() => {
    if (loaded) {
      localStorage.setItem(STORAGE_KEY_MESSAGES, JSON.stringify(messages));
    }
  }, [messages, loaded]);

  useEffect(() => {
    if (loaded) {
      localStorage.setItem(STORAGE_KEY_HANDOFFS, JSON.stringify(handoffs));
    }
  }, [handoffs, loaded]);

  const addAgent = useCallback((agent: Agent) => {
    setAgents(prev => [agent, ...prev]);
  }, []);

  const addListing = useCallback((listing: Listing) => {
    setListings(prev => [listing, ...prev]);
  }, []);

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
      a.skills.some(s => s.name.toLowerCase().includes(q)) ||
      a.categories.some(c => c.toLowerCase().includes(q))
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
      l.categories.some(c => c.toLowerCase().includes(q))
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

  const sendMessage = useCallback((msg: DirectMessage) => {
    setMessages(prev => [...prev, msg]);
    setChannels(prev => prev.map(c =>
      c.id === msg.channelId ? { ...c, lastMessageAt: msg.timestamp } : c
    ));
  }, []);

  const getOrCreateChannel = useCallback((agentId1: string, agentName1: string, agentId2: string, agentName2: string): DMChannel => {
    const existing = channels.find(c =>
      c.agentIds.includes(agentId1) && c.agentIds.includes(agentId2)
    );
    if (existing) return existing;

    const newChannel: DMChannel = {
      id: `channel-${Date.now()}`,
      agentIds: [agentId1, agentId2],
      agentNames: [agentName1, agentName2],
      createdAt: new Date().toISOString(),
      lastMessageAt: new Date().toISOString(),
    };
    setChannels(prev => [newChannel, ...prev]);
    return newChannel;
  }, [channels]);

  const getHandoffsForAgent = useCallback((agentId: string) => {
    return handoffs.filter(h => h.fromAgentId === agentId || h.toAgentId === agentId);
  }, [handoffs]);

  const addHandoff = useCallback((handoff: Handoff) => {
    setHandoffs(prev => [handoff, ...prev]);
  }, []);

  const updateHandoffStatus = useCallback((handoffId: string, status: Handoff['status']) => {
    setHandoffs(prev => prev.map(h =>
      h.id === handoffId ? { ...h, status, updatedAt: new Date().toISOString() } : h
    ));
  }, []);

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
