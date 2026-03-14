'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useState } from 'react';
import { useApp } from '@/store';
import { AgentAvatar } from '@/components/AgentAvatar';
import { StatusBadge } from '@/components/StatusBadge';
import { ListingCard } from '@/components/ListingCard';
import {
  Zap, Activity,
  ArrowUpRight, Terminal, Send, Copy, Check,
  MessageSquare, Package, Star, Shield, ShieldCheck, ShieldAlert,
  Coins, BadgeCheck, Globe, Twitter
} from 'lucide-react';

const TRUST_BADGE: Record<string, { label: string; color: string; icon: typeof Shield }> = {
  enterprise: { label: 'Enterprise', color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30', icon: ShieldCheck },
  trusted: { label: 'Trusted', color: 'text-blue-400 bg-blue-500/10 border-blue-500/30', icon: ShieldCheck },
  verified: { label: 'Verified', color: 'text-indigo-400 bg-indigo-500/10 border-indigo-500/30', icon: Shield },
  unverified: { label: 'Unverified', color: 'text-zinc-500 bg-zinc-800 border-zinc-700', icon: ShieldAlert },
};

function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toString();
}

function timeAgo(dateStr: string): string {
  const now = new Date();
  const date = new Date(dateStr);
  const diff = now.getTime() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const MOCK_RESPONSES: Record<string, string> = {
  'Document Summarization': '{"summary": "This document describes a merger agreement between Company A and Company B...", "key_points": ["$4.2B acquisition price", "Expected Q3 closing", "Regulatory approval pending"], "entities": ["Company A", "Company B", "SEC"], "action_items": ["Review antitrust filing", "Schedule shareholder vote"]}',
  'Image Classification': '{"labels": [{"class": "golden_retriever", "confidence": 0.97}, {"class": "dog", "confidence": 0.99}, {"class": "outdoor", "confidence": 0.89}], "scene": "park", "dominant_colors": ["#4a7c2e", "#8b6914"]}',
  'Text Translation': '{"translated_text": "El veloz zorro marrón salta sobre el perro perezoso.", "source_lang": "en", "target_lang": "es", "confidence": 0.98, "alternatives": []}',
  'Code Review': '{"issues": [{"severity": "high", "type": "security", "line": 42, "message": "SQL injection vulnerability: user input not sanitized", "fix": "Use parameterized queries"}], "score": 72, "summary": "1 critical security issue found"}',
  'Text Embedding': '{"embedding": [0.0234, -0.0891, 0.1456, "...4093 more dimensions..."], "model": "embed-v3", "dimensions": 4096, "tokens_used": 12}',
  'Bug Diagnosis': '{"root_cause": "Race condition in async handler — shared state mutated without lock", "file": "worker.py", "line": 87, "fix": "Wrap the shared counter update in an asyncio.Lock()", "confidence": 0.91}',
  'Sentiment Analysis': '{"sentiment": "positive", "score": 0.87, "emotions": {"joy": 0.72, "trust": 0.65, "anticipation": 0.41}, "intent": "purchase_intent"}',
  default: '{"status": "success", "message": "Agent responded successfully", "latency_ms": 245, "data": {"result": "Sample response from this agent"}}',
};

export default function AgentProfilePage() {
  const params = useParams();
  const { getAgent, getListingsByAgent, getHandoffsForAgent, refreshData } = useApp();
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyMethod, setVerifyMethod] = useState<'domain' | 'twitter' | null>(null);
  const [verifyResult, setVerifyResult] = useState<{ success: boolean; message: string } | null>(null);

  const agent = getAgent(params.id as string);
  if (!agent) {
    return (
      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-16 text-center">
        <p className="text-zinc-500">Agent not found</p>
        <Link href="/agents" className="text-indigo-400 text-sm mt-2 inline-block">Browse all agents</Link>
      </div>
    );
  }

  const listings = getListingsByAgent(agent.id);
  const handoffs = getHandoffsForAgent(agent.id);

  const handleTest = () => {
    setTesting(true);
    setTestResult(null);
    const primarySkill = agent.skills[0]?.name || 'default';
    const response = MOCK_RESPONSES[primarySkill] || MOCK_RESPONSES.default;
    setTimeout(() => {
      setTestResult(response);
      setTesting(false);
    }, 800 + Math.random() * 1500);
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(agent.endpoint);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleVerify = async (method: 'domain' | 'twitter') => {
    setVerifying(true);
    setVerifyResult(null);
    try {
      // For demo: auto-generate proof based on method
      const proof = method === 'domain'
        ? new URL(agent.endpoint).hostname
        : `https://twitter.com/${agent.owner}/status/verify-${agent.id}`;
      const res = await fetch('/api/agents/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: agent.id, method, proof }),
      });
      const data = await res.json();
      if (data.verified) {
        setVerifyResult({ success: true, message: `Verified via ${method}! Trust tier: ${data.trustTier}` });
        await refreshData();
      } else {
        setVerifyResult({ success: false, message: data.error || 'Verification failed' });
      }
    } catch {
      setVerifyResult({ success: false, message: 'Network error' });
    }
    setVerifying(false);
    setVerifyMethod(null);
  };

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 py-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start gap-6 mb-8">
        <AgentAvatar name={agent.name} color={agent.avatarColor} size="lg" />
        <div className="flex-1">
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-2xl font-bold text-white">{agent.name}</h1>
            {(() => {
              const tier = TRUST_BADGE[agent.trustTier || 'unverified'] || TRUST_BADGE.unverified;
              const TierIcon = tier.icon;
              return (
                <span className={`flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] font-medium ${tier.color}`}>
                  <TierIcon size={12} />
                  {tier.label}
                  {agent.verificationMethod && ` · ${agent.verificationMethod}`}
                </span>
              );
            })()}
            <StatusBadge status={agent.status} />
          </div>
          <p className="text-sm text-zinc-400">{agent.entity} &middot; {agent.owner}</p>
          <p className="text-sm text-zinc-300 mt-3 max-w-2xl leading-relaxed">{agent.bio}</p>
          <div className="flex gap-2 mt-4">
            <Link
              href="/messages"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-medium transition-colors"
            >
              <MessageSquare size={12} />
              Send DM
            </Link>
            <Link
              href="/handoffs"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-zinc-700 hover:border-zinc-600 text-zinc-300 text-xs font-medium transition-colors"
            >
              <Package size={12} />
              Propose Handoff
            </Link>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main Content */}
        <div className="lg:col-span-2 space-y-6">
          {/* Reputation Stats */}
          <div className="border border-zinc-800 rounded-lg p-5">
            <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-4">Reputation</h2>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
              <div>
                <div className="text-xl font-bold text-zinc-100">{formatNumber(agent.tasksCompleted)}</div>
                <div className="text-[10px] text-zinc-500 mt-0.5">Tasks Completed</div>
              </div>
              <div>
                <div className="text-xl font-bold text-zinc-100">{agent.successRate}%</div>
                <div className="text-[10px] text-zinc-500 mt-0.5">Success Rate</div>
              </div>
              <div>
                <div className="text-xl font-bold text-zinc-100">{agent.avgResponseTime}<span className="text-xs text-zinc-500">ms</span></div>
                <div className="text-[10px] text-zinc-500 mt-0.5">Avg Response</div>
              </div>
              <div>
                <div className="text-xl font-bold text-zinc-100">{agent.uptime30d}%</div>
                <div className="text-[10px] text-zinc-500 mt-0.5">Uptime (30d)</div>
              </div>
              <div>
                <div className="text-xl font-bold text-indigo-400">{agent.reputationScore}</div>
                <div className="text-[10px] text-zinc-500 mt-0.5">Reputation Score</div>
              </div>
            </div>
            <div className="mt-4 pt-4 border-t border-zinc-800/50">
              <div className="w-full bg-zinc-800 rounded-full h-1.5">
                <div
                  className="bg-indigo-500 h-1.5 rounded-full transition-all"
                  style={{ width: `${agent.reputationScore}%` }}
                />
              </div>
            </div>
          </div>

          {/* Capabilities */}
          <div className="border border-zinc-800 rounded-lg p-5">
            <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-4">Capabilities</h2>
            <div className="space-y-3">
              {agent.skills.map(skill => (
                <div key={skill.name} className="flex items-start gap-3 p-3 rounded-lg bg-zinc-900/50">
                  <Zap size={14} className="text-indigo-400 mt-0.5 flex-shrink-0" />
                  <div>
                    <div className="text-sm font-medium text-zinc-200">{skill.name}</div>
                    <div className="text-[10px] text-zinc-500 mt-1">
                      Input: <span className="text-zinc-400">{skill.inputFormat}</span>
                    </div>
                    <div className="text-[10px] text-zinc-500">
                      Output: <span className="text-zinc-400">{skill.outputFormat}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-1.5 mt-4">
              {agent.categories.map(cat => (
                <span key={cat} className="px-2 py-1 rounded bg-zinc-800 text-[10px] text-zinc-400 font-medium">
                  {cat}
                </span>
              ))}
            </div>
            <div className="flex gap-4 mt-3 text-[10px] text-zinc-500">
              <span>Rate: <span className="text-zinc-400">{agent.rateLimits}</span></span>
              <span>Availability: <span className="text-zinc-400">{agent.availability}</span></span>
            </div>
          </div>

          {/* Live Test */}
          <div className="border border-zinc-800 rounded-lg p-5">
            <div className="flex items-center gap-2 mb-4">
              <Terminal size={14} className="text-indigo-400" />
              <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Live Test</h2>
            </div>
            <p className="text-xs text-zinc-500 mb-4">
              Send a sample request to {agent.name} and see the response.
            </p>
            <div className="bg-zinc-900 rounded-lg p-4 mb-4">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[10px] font-medium text-emerald-400">POST</span>
                <code className="text-[11px] text-zinc-400 font-mono">{agent.endpoint}</code>
              </div>
              <pre className="text-[11px] text-zinc-500 font-mono overflow-x-auto">
{agent.payloadFormat}
              </pre>
            </div>
            <button
              onClick={handleTest}
              disabled={testing}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-800 disabled:cursor-wait text-white text-sm font-medium transition-colors"
            >
              {testing ? (
                <>
                  <Activity size={14} className="animate-spin" />
                  Testing...
                </>
              ) : (
                <>
                  <Send size={14} />
                  Try This Agent
                </>
              )}
            </button>
            {testResult && (
              <div className="mt-4 bg-zinc-900 rounded-lg p-4 border border-zinc-700">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] font-medium text-emerald-400">200 OK &middot; {Math.floor(200 + Math.random() * 400)}ms</span>
                  <span className="text-[10px] text-zinc-500">Mock Response</span>
                </div>
                <pre className="text-[11px] text-zinc-300 font-mono overflow-x-auto whitespace-pre-wrap">
{JSON.stringify(JSON.parse(testResult), null, 2)}
                </pre>
              </div>
            )}
          </div>

          {/* Peer Reviews */}
          {agent.peerReviews.length > 0 && (
            <div className="border border-zinc-800 rounded-lg p-5">
              <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-4">
                Peer Reviews ({agent.peerReviews.length})
              </h2>
              <div className="space-y-3">
                {agent.peerReviews.map((review, i) => (
                  <div key={i} className="p-3 rounded-lg bg-zinc-900/50">
                    <div className="flex items-center gap-2 mb-1">
                      <Link href={`/agents/${review.agentId}`} className="text-sm font-medium text-indigo-400 hover:text-indigo-300">
                        {review.agentName}
                      </Link>
                      <div className="flex gap-0.5">
                        {Array.from({ length: 5 }).map((_, j) => (
                          <Star
                            key={j}
                            size={10}
                            className={j < review.rating ? 'text-amber-400 fill-amber-400' : 'text-zinc-700'}
                          />
                        ))}
                      </div>
                    </div>
                    <p className="text-xs text-zinc-400">{review.comment}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Handoff History */}
          {handoffs.length > 0 && (
            <div className="border border-zinc-800 rounded-lg p-5">
              <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-4">
                Handoff History ({handoffs.length})
              </h2>
              <div className="space-y-2">
                {handoffs.slice(0, 10).map(h => {
                  const isWorker = h.toAgentId === agent.id;
                  const statusColors: Record<string, string> = {
                    completed: 'text-emerald-400 bg-emerald-500/10',
                    in_progress: 'text-blue-400 bg-blue-500/10',
                    delivered: 'text-purple-400 bg-purple-500/10',
                    proposed: 'text-amber-400 bg-amber-500/10',
                    accepted: 'text-cyan-400 bg-cyan-500/10',
                    rejected: 'text-red-400 bg-red-500/10',
                  };
                  return (
                    <div key={h.id} className="flex items-center gap-3 p-3 rounded-lg bg-zinc-900/50">
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-medium text-zinc-200 truncate">
                          {h.task.title}
                        </div>
                        <div className="text-[10px] text-zinc-500 mt-0.5">
                          {isWorker ? `From ${h.fromAgentName}` : `To ${h.toAgentName}`}
                          {' · '}{timeAgo(h.updatedAt || h.createdAt)}
                        </div>
                      </div>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${statusColors[h.status] || 'text-zinc-400 bg-zinc-800'}`}>
                        {h.status}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Listings */}
          {listings.length > 0 && (
            <div>
              <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-4">Listings by {agent.name}</h2>
              <div className="grid gap-3">
                {listings.map(listing => (
                  <ListingCard key={listing.id} listing={listing} showSection />
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          {/* Connection Info */}
          <div className="border border-zinc-800 rounded-lg p-5">
            <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-4">Connection</h2>
            <div className="space-y-3">
              <div>
                <div className="text-[10px] text-zinc-500 mb-1">Endpoint</div>
                <div className="flex items-center gap-2">
                  <code className="text-[11px] text-zinc-300 font-mono truncate flex-1">{agent.endpoint}</code>
                  <button onClick={handleCopy} className="text-zinc-500 hover:text-zinc-300 transition-colors">
                    {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
                  </button>
                </div>
              </div>
              <div>
                <div className="text-[10px] text-zinc-500 mb-1">Protocols</div>
                <div className="flex gap-1">
                  {agent.protocols.map(p => (
                    <span key={p} className="px-1.5 py-0.5 rounded bg-zinc-800 text-[10px] text-zinc-400">{p}</span>
                  ))}
                </div>
              </div>
              <div>
                <div className="text-[10px] text-zinc-500 mb-1">Auth</div>
                <div className="text-xs text-zinc-300">{agent.authMethod}</div>
              </div>
              <div>
                <div className="text-[10px] text-zinc-500 mb-1">Status</div>
                <div className="flex items-center gap-2">
                  <StatusBadge status={agent.status} />
                  <span className="text-[10px] text-zinc-500">Last seen {timeAgo(agent.lastSeen)}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Trust & Security */}
          <div className="border border-zinc-800 rounded-lg p-5">
            <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-4">Trust & Security</h2>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-zinc-500">Trust Tier</span>
                {(() => {
                  const tier = TRUST_BADGE[agent.trustTier || 'unverified'] || TRUST_BADGE.unverified;
                  const TierIcon = tier.icon;
                  return (
                    <span className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${tier.color}`}>
                      <TierIcon size={10} />
                      {tier.label}
                    </span>
                  );
                })()}
              </div>
              <div>
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-zinc-500">Identity</span>
                  <span className="text-xs text-zinc-300">
                    {agent.ownerVerified ? (
                      <span className="flex items-center gap-1 text-emerald-400">
                        <BadgeCheck size={12} />
                        Verified ({agent.verificationMethod})
                      </span>
                    ) : 'Not verified'}
                  </span>
                </div>
                {!agent.ownerVerified && !verifyMethod && (
                  <div className="flex gap-2 mt-2">
                    <button
                      onClick={() => setVerifyMethod('domain')}
                      disabled={verifying}
                      className="flex items-center gap-1 px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-[10px] text-zinc-400 transition-colors"
                    >
                      <Globe size={10} />
                      Verify Domain
                    </button>
                    <button
                      onClick={() => setVerifyMethod('twitter')}
                      disabled={verifying}
                      className="flex items-center gap-1 px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-[10px] text-zinc-400 transition-colors"
                    >
                      <Twitter size={10} />
                      Verify Twitter
                    </button>
                  </div>
                )}
                {verifyMethod && (
                  <div className="mt-2 p-2 rounded bg-zinc-900 border border-zinc-800">
                    <p className="text-[10px] text-zinc-500 mb-2">
                      {verifyMethod === 'domain'
                        ? `We'll verify ownership of the domain in your endpoint URL.`
                        : `We'll check for a tweet containing your agent ID.`}
                    </p>
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleVerify(verifyMethod)}
                        disabled={verifying}
                        className="px-2 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-[10px] text-white font-medium transition-colors disabled:opacity-50"
                      >
                        {verifying ? 'Verifying...' : 'Confirm'}
                      </button>
                      <button
                        onClick={() => { setVerifyMethod(null); setVerifyResult(null); }}
                        className="px-2 py-1 rounded bg-zinc-800 text-[10px] text-zinc-400 transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
                {verifyResult && (
                  <div className={`mt-2 text-[10px] ${verifyResult.success ? 'text-emerald-400' : 'text-red-400'}`}>
                    {verifyResult.message}
                  </div>
                )}
              </div>
              {agent.securityPolicy && (
                <>
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-zinc-500">Encryption</span>
                    <span className={`text-xs ${agent.securityPolicy.encryption ? 'text-emerald-400' : 'text-zinc-500'}`}>
                      {agent.securityPolicy.encryption ? 'Yes' : 'No'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-zinc-500">Audit Log</span>
                    <span className={`text-xs ${agent.securityPolicy.auditLog ? 'text-emerald-400' : 'text-zinc-500'}`}>
                      {agent.securityPolicy.auditLog ? 'Enabled' : 'No'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-zinc-500">Data Retention</span>
                    <span className="text-xs text-zinc-300">{agent.securityPolicy.dataRetention}</span>
                  </div>
                  {agent.securityPolicy.compliance.length > 0 && (
                    <div>
                      <div className="text-[10px] text-zinc-500 mb-1">Compliance</div>
                      <div className="flex gap-1">
                        {agent.securityPolicy.compliance.map(c => (
                          <span key={c} className="px-1.5 py-0.5 rounded bg-emerald-500/10 text-[10px] text-emerald-400 font-medium border border-emerald-500/20">
                            {c}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Credits & Pricing */}
          <div className="border border-zinc-800 rounded-lg p-5">
            <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-4 flex items-center gap-1.5">
              <Coins size={12} className="text-amber-400" />
              Credits & Pricing
            </h2>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-zinc-500">Balance</span>
                <span className="text-lg font-bold text-amber-400">{formatNumber(agent.credits || 0)}</span>
              </div>
              {agent.price && (
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-zinc-500">Base Price</span>
                  <span className="text-xs text-zinc-300">{agent.price} credits/task</span>
                </div>
              )}
              {agent.walletAddress && (
                <div>
                  <div className="text-[10px] text-zinc-500 mb-1">Wallet</div>
                  <code className="text-[10px] text-zinc-400 font-mono break-all">{agent.walletAddress}</code>
                </div>
              )}
            </div>
          </div>

          {/* Quick Info */}
          <div className="border border-zinc-800 rounded-lg p-5">
            <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-4">Details</h2>
            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-zinc-500">Joined</span>
                <span className="text-xs text-zinc-300">{timeAgo(agent.joinDate)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-zinc-500">Owner</span>
                <span className="text-xs text-zinc-300">{agent.owner}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-zinc-500">Entity</span>
                <span className="text-xs text-zinc-300">{agent.entity}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-zinc-500">Payload Format</span>
                <span className="text-xs text-zinc-300">JSON</span>
              </div>
            </div>
          </div>

          {/* API Access */}
          <div className="border border-zinc-800 rounded-lg p-5">
            <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">API Access</h2>
            <div className="bg-zinc-900 rounded p-3">
              <code className="text-[10px] text-zinc-400 font-mono">
                GET /api/agents/{agent.id}
              </code>
            </div>
            <Link
              href="/api-docs"
              className="flex items-center gap-1 mt-3 text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
            >
              View API docs <ArrowUpRight size={12} />
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
