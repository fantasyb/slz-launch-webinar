'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useApp } from '@/store';
import type { Agent } from '@/data/seed';

const AVATAR_COLORS = [
  '#6366f1', '#8b5cf6', '#ec4899', '#f43f5e', '#f97316',
  '#eab308', '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6',
];

const CATEGORIES = ['code', 'data', 'design', 'research', 'writing'];

export default function RegisterPage() {
  const router = useRouter();
  const { addAgent } = useApp();

  const [form, setForm] = useState({
    name: '',
    owner: '',
    entity: '',
    bio: '',
    endpoint: '',
    authMethod: 'API Key',
    protocols: ['REST'],
    skillName: '',
    skillInput: '',
    skillOutput: '',
    categories: [] as string[],
  });
  const [skills, setSkills] = useState<{ name: string; inputFormat: string; outputFormat: string }[]>([]);

  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name || !form.endpoint || !form.bio || submitting) return;

    setSubmitting(true);

    const agent: Agent = {
      id: `agent-${Date.now()}`,
      name: form.name,
      avatarColor: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)],
      owner: form.owner || 'Anonymous',
      ownerVerified: false,
      verificationMethod: null,
      entity: form.entity || 'Independent',
      bio: form.bio,
      skills: skills.length > 0 ? skills : [{ name: 'General', inputFormat: 'application/json', outputFormat: 'application/json' }],
      categories: form.categories.length > 0 ? form.categories : ['code'],
      rateLimits: 'Not specified',
      availability: '24/7',
      tasksCompleted: 0,
      successRate: 0,
      avgResponseTime: 0,
      uptime30d: 0,
      joinDate: new Date().toISOString(),
      peerReviews: [],
      endpoint: form.endpoint,
      protocols: form.protocols,
      authMethod: form.authMethod,
      payloadFormat: '{"input": "..."}',
      status: 'online',
      lastSeen: new Date().toISOString(),
      price: null,
      walletAddress: null,
      reputationScore: 0,
      trustTier: 'unverified',
      securityPolicy: null,
    };

    await addAgent(agent);
    router.push('/agents');
    setSubmitting(false);
  };

  const addSkill = () => {
    if (!form.skillName) return;
    setSkills(prev => [...prev, {
      name: form.skillName,
      inputFormat: form.skillInput || 'application/json',
      outputFormat: form.skillOutput || 'application/json',
    }]);
    setForm(prev => ({ ...prev, skillName: '', skillInput: '', skillOutput: '' }));
  };

  const toggleCategory = (cat: string) => {
    setForm(prev => ({
      ...prev,
      categories: prev.categories.includes(cat)
        ? prev.categories.filter(c => c !== cat)
        : [...prev.categories, cat],
    }));
  };

  const toggleProtocol = (proto: string) => {
    setForm(prev => ({
      ...prev,
      protocols: prev.protocols.includes(proto)
        ? prev.protocols.filter(p => p !== proto)
        : [...prev.protocols, proto],
    }));
  };

  return (
    <div className="mx-auto max-w-2xl px-4 sm:px-6 py-8">
      <h1 className="text-2xl font-bold text-white mb-2">Register Your Agent</h1>
      <p className="text-sm text-zinc-400 mb-8">Add your agent to the directory. It takes 30 seconds.</p>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Identity */}
        <div className="border border-zinc-800 rounded-lg p-5">
          <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-4">Identity</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Agent Name *</label>
              <input
                type="text"
                value={form.name}
                onChange={e => setForm(prev => ({ ...prev, name: e.target.value }))}
                placeholder="e.g. SummarizerBot"
                className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-indigo-500/50"
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Owner Handle</label>
                <input
                  type="text"
                  value={form.owner}
                  onChange={e => setForm(prev => ({ ...prev, owner: e.target.value }))}
                  placeholder="@yourhandle"
                  className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-indigo-500/50"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Entity / Company</label>
                <input
                  type="text"
                  value={form.entity}
                  onChange={e => setForm(prev => ({ ...prev, entity: e.target.value }))}
                  placeholder="e.g. Acme Inc."
                  className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-indigo-500/50"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Description *</label>
              <textarea
                value={form.bio}
                onChange={e => setForm(prev => ({ ...prev, bio: e.target.value }))}
                placeholder="What does your agent do? Be specific about capabilities, performance, and use cases."
                rows={4}
                className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-indigo-500/50 resize-none"
                required
              />
            </div>
          </div>
        </div>

        {/* Skills */}
        <div className="border border-zinc-800 rounded-lg p-5">
          <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-4">Skills</h2>
          {skills.length > 0 && (
            <div className="space-y-2 mb-4">
              {skills.map((skill, i) => (
                <div key={i} className="flex items-center justify-between p-2 rounded bg-zinc-900/50">
                  <span className="text-xs text-zinc-300">{skill.name}</span>
                  <button
                    type="button"
                    onClick={() => setSkills(prev => prev.filter((_, j) => j !== i))}
                    className="text-[10px] text-zinc-500 hover:text-red-400"
                  >
                    remove
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="grid grid-cols-3 gap-2">
            <input
              type="text"
              value={form.skillName}
              onChange={e => setForm(prev => ({ ...prev, skillName: e.target.value }))}
              placeholder="Skill name"
              className="px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-indigo-500/50"
            />
            <input
              type="text"
              value={form.skillInput}
              onChange={e => setForm(prev => ({ ...prev, skillInput: e.target.value }))}
              placeholder="Input format"
              className="px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-indigo-500/50"
            />
            <input
              type="text"
              value={form.skillOutput}
              onChange={e => setForm(prev => ({ ...prev, skillOutput: e.target.value }))}
              placeholder="Output format"
              className="px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-indigo-500/50"
            />
          </div>
          <button
            type="button"
            onClick={addSkill}
            className="mt-2 px-3 py-1.5 rounded text-xs text-indigo-400 hover:text-indigo-300 border border-zinc-800 hover:border-zinc-700 transition-colors"
          >
            + Add Skill
          </button>

          <div className="mt-4">
            <label className="block text-xs text-zinc-400 mb-2">Categories</label>
            <div className="flex gap-2 flex-wrap">
              {CATEGORIES.map(cat => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => toggleCategory(cat)}
                  className={`px-2.5 py-1 rounded text-xs transition-colors ${
                    form.categories.includes(cat)
                      ? 'bg-indigo-600 text-white'
                      : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Connection */}
        <div className="border border-zinc-800 rounded-lg p-5">
          <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-4">Connection</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Endpoint URL *</label>
              <input
                type="url"
                value={form.endpoint}
                onChange={e => setForm(prev => ({ ...prev, endpoint: e.target.value }))}
                placeholder="https://api.youragent.com/v1/endpoint"
                className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-indigo-500/50"
                required
              />
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-2">Protocols</label>
              <div className="flex gap-2">
                {['REST', 'webhook', 'A2A'].map(proto => (
                  <button
                    key={proto}
                    type="button"
                    onClick={() => toggleProtocol(proto)}
                    className={`px-2.5 py-1 rounded text-xs transition-colors ${
                      form.protocols.includes(proto)
                        ? 'bg-indigo-600 text-white'
                        : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {proto}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Auth Method</label>
              <select
                value={form.authMethod}
                onChange={e => setForm(prev => ({ ...prev, authMethod: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-sm text-zinc-300 focus:outline-none"
              >
                <option>API Key</option>
                <option>Bearer Token</option>
                <option>OAuth 2.0</option>
                <option>mTLS</option>
                <option>None</option>
              </select>
            </div>
          </div>
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="w-full px-5 py-3 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
        >
          {submitting ? 'Registering...' : 'Register Agent'}
        </button>
      </form>
    </div>
  );
}
