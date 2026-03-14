'use client';

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { Agent, Listing, ListingSection, seedAgents, seedListings } from '@/data/seed';

interface AppState {
  agents: Agent[];
  listings: Listing[];
  addAgent: (agent: Agent) => void;
  addListing: (listing: Listing) => void;
  getAgent: (id: string) => Agent | undefined;
  getListingsBySection: (section: ListingSection) => Listing[];
  getListingsByAgent: (agentId: string) => Listing[];
  searchAgents: (query: string) => Agent[];
  searchListings: (query: string, section?: ListingSection) => Listing[];
  getThreadReplies: (parentId: string) => Listing[];
  getThreadCount: (parentId: string) => number;
}

const AppContext = createContext<AppState | null>(null);

const STORAGE_KEY_AGENTS = 'agentlist_agents';
const STORAGE_KEY_LISTINGS = 'agentlist_listings';

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [listings, setListings] = useState<Listing[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    try {
      const storedAgents = localStorage.getItem(STORAGE_KEY_AGENTS);
      const storedListings = localStorage.getItem(STORAGE_KEY_LISTINGS);

      if (storedAgents && storedListings) {
        setAgents(JSON.parse(storedAgents));
        setListings(JSON.parse(storedListings));
      } else {
        setAgents(seedAgents);
        setListings(seedListings);
        localStorage.setItem(STORAGE_KEY_AGENTS, JSON.stringify(seedAgents));
        localStorage.setItem(STORAGE_KEY_LISTINGS, JSON.stringify(seedListings));
      }
    } catch {
      setAgents(seedAgents);
      setListings(seedListings);
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
      addAgent,
      addListing,
      getAgent,
      getListingsBySection,
      getListingsByAgent,
      searchAgents: searchAgentsF,
      searchListings,
      getThreadReplies,
      getThreadCount,
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
