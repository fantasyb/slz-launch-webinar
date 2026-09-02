import { readFileSync } from 'fs';
export function parse(path) {
  const text = readFileSync(path, 'utf8');
  const [head, ...rows] = text.trim().split('\n');
  const cols = head.split(',');
  return rows.map((r) => Object.fromEntries(r.split(',').map((v, i) => [cols[i], v])));
}
export function dedupe(records) {
  const seen = new Set();
  return records.filter((r) => (seen.has(r.email) ? false : (seen.add(r.email), true)));
}
