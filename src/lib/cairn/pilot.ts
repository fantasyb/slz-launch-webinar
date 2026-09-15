import type { RetrievalRecord } from './ledger';

export interface PilotConnection {
  name: string;
  state: string;
  reason: string;
  autowrite: boolean;
}

/** Count only gateway events in the requested window. Legacy rows remain
 * visible as unattributed calls; they must not be assigned to a guessed server. */
export function pilotSummary(records: RetrievalRecord[], connections: PilotConnection[], days = 7, now = Date.now()) {
  const since = now - days * 86_400_000;
  const rows = records.filter((r) => {
    const at = Date.parse(r?.at);
    return typeof r?.source === 'string' && r.source.startsWith('mcp-proxy:') && Number.isFinite(at) && at >= since && at <= now;
  });
  const callSources = new Set(['mcp-proxy:call', 'mcp-proxy:error', 'mcp-proxy:cancelled']);
  const calls = rows.filter((r) => callSources.has(r.source!));
  const seen = new Set<string>();
  const measured = calls.filter((r) => {
    if (!r.call || typeof r.call.id !== 'string' || seen.has(r.call.id)) return false;
    seen.add(r.call.id);
    return true;
  });
  const summaries = connections.map((connection) => {
    const traffic = measured.filter((r) => r.call!.server === connection.name);
    const latest = traffic.reduce<string | null>((last, r) => !last || r.at > last ? r.at : last, null);
    const times = traffic.map((r) => r.call!.elapsedMs).filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
    return { ...connection, calls: traffic.length,
      toolSuccesses: traffic.filter((r) => r.call!.status === 'tool-success').length,
      errors: traffic.filter((r) => ['tool-error', 'transport-error'].includes(r.call!.status)).length,
      cancelled: traffic.filter((r) => r.call!.status === 'cancelled').length,
      lastCallAt: latest, p95CallMs: times.length ? times[Math.ceil(times.length * 0.95) - 1] : null };
  });
  const annotations = rows.filter((r) => r.source === 'mcp-proxy:result');
  return {
    days, since: new Date(since).toISOString(), until: new Date(now).toISOString(),
    calls: measured.length + calls.filter((r) => !r.call).length,
    legacyCalls: calls.filter((r) => !r.call).length,
    otherConnectionCalls: measured.filter((r) => !connections.some((c) => c.name === r.call!.server)).length,
    resultAnnotations: annotations.length,
    resultPatternMatches: annotations.filter((r) => r.matchedBy === 'result-signature').length,
    broadToolMatches: annotations.filter((r) => r.matchedBy === 'tool').length,
    unknownMatchReason: annotations.filter((r) => !r.matchedBy).length,
    autoWritten: rows.filter((r) => r.source === 'mcp-proxy:autowrite').length,
    captureRejected: rows.filter((r) => ['mcp-proxy:autowrite-rejected', 'mcp-proxy:autowrite-refused'].includes(r.source!)).length,
    taskOutcomes: 'not-measured' as const,
    connections: summaries,
  };
}

/** Allowlist for a report a tester can choose to share. Never include raw
 * configuration, names, queries, findings, payloads, paths, or identities. */
export function sharePilotReport(summary: ReturnType<typeof pilotSummary>) {
  return { format: 'cairn-pilot-v1', days: summary.days, calls: summary.calls,
    legacyCalls: summary.legacyCalls, otherConnectionCalls: summary.otherConnectionCalls,
    resultAnnotations: summary.resultAnnotations, resultPatternMatches: summary.resultPatternMatches,
    broadToolMatches: summary.broadToolMatches, unknownMatchReason: summary.unknownMatchReason,
    autoWritten: summary.autoWritten, captureRejected: summary.captureRejected, taskOutcomes: summary.taskOutcomes,
    connections: summary.connections.map((c, i) => ({ alias: `connection-${i + 1}`,
      state: c.state, autowrite: c.autowrite, calls: c.calls, toolSuccesses: c.toolSuccesses,
      errors: c.errors, cancelled: c.cancelled, p95CallMs: c.p95CallMs })),
  };
}
