// Sums events into calendar weeks for the reporting timezone.
const TZ_OFFSET_HOURS = -5; // America/New_York
export function weekOf(isoTimestamp) {
  const t = new Date(isoTimestamp);
  const local = new Date(t.getTime() + TZ_OFFSET_HOURS * 3600 * 1000);
  const day = local.getUTCDay();
  const monday = new Date(local.getTime() - ((day + 6) % 7) * 86400000);
  return monday.toISOString().slice(0, 10);
}
export function bucket(events) {
  const out = {};
  for (const e of events) out[weekOf(e.at)] = (out[weekOf(e.at)] ?? 0) + 1;
  return out;
}
