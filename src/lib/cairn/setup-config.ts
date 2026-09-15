/** Client configuration editing. Preserve unrelated JSONC/TOML text and reject
 * ambiguous documents rather than silently changing their interpretation. */
import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import * as jsonc from 'jsonc-parser';
import * as toml from '@iarna/toml';

export type ObjectValue = Record<string, unknown>;
export type ConfigFormat = 'jsonc' | 'toml';
export const object = (v: unknown): v is ObjectValue => !!v && typeof v === 'object' && !Array.isArray(v);
export function readText(file: string): string {
  const s = fs.statSync(file);
  if (!s.isFile() || s.size > 4 * 1024 * 1024) throw new Error('Configuration is not a regular file under 4 MB.');
  return fs.readFileSync(file, 'utf8');
}
export function parseConfig(raw: string, format: ConfigFormat): ObjectValue {
  try {
    if (format === 'toml') return JSON.parse(JSON.stringify(toml.parse(raw))) as ObjectValue;
    const errors: jsonc.ParseError[] = [];
    const tree = jsonc.parseTree(raw, errors, { allowTrailingComma: true });
    if (errors.length || !tree || tree.type !== 'object') throw new Error('invalid');
    const check = (node: jsonc.Node) => {
      if (node.type === 'object') {
        const keys = (node.children ?? []).map((p) => p.children![0].value);
        if (new Set(keys).size !== keys.length) throw new Error('duplicate keys');
      }
      for (const c of node.children ?? []) check(c);
    };
    check(tree);
    return JSON.parse(JSON.stringify(jsonc.getNodeValue(tree)));
  } catch { throw new Error('Configuration could not be read safely. Check its syntax in the client; no contents are printed.'); }
}
export function atPath(doc: ObjectValue, keys: string[]): unknown {
  let v: unknown = doc;
  for (const k of keys) { if (!object(v) || !Object.hasOwn(v, k)) return undefined; v = v[k]; }
  return v;
}

export function editEntry(raw: string, format: ConfigFormat, keys: string[], value: ObjectValue): string {
  const before = parseConfig(raw, format);
  const expected = structuredClone(before);
  let parent = expected;
  for (const k of keys.slice(0, -1)) {
    if (!object(parent[k])) throw new Error('Server configuration moved. Rescan before connecting.');
    parent = parent[k] as ObjectValue;
  }
  Object.defineProperty(parent, keys.at(-1)!, { value, enumerable: true, configurable: true, writable: true });
  let next: string;
  if (format === 'jsonc') {
    next = jsonc.applyEdits(raw, jsonc.modify(raw, keys, value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: raw.includes('\r\n') ? '\r\n' : '\n' } }));
  } else {
    if (keys.length !== 2 || keys[0] !== 'mcp_servers') throw new Error('Unsupported TOML server layout.');
    // Parse each table header with TOML itself (including quoted server names).
    // Final whole-document equivalence catches headers embedded in multiline
    // strings and inline/dotted layouts that cannot be edited independently.
    const headers = [...raw.matchAll(/^\s*\[[^\r\n]+\][ \t]*(?:#[^\r\n]*)?$/gm)];
    const ranges: Array<[number, number]> = [];
    for (let i = 0; i < headers.length; i++) {
      try {
        const h = toml.parse(headers[i][0]);
        if (object(h.mcp_servers) && Object.hasOwn(h.mcp_servers, keys[1])) ranges.push([headers[i].index!, headers[i + 1]?.index ?? raw.length]);
      } catch { /* unsupported headers fail the equivalence check below */ }
    }
    if (!ranges.length) throw new Error('This TOML layout needs manual setup; use a separate [mcp_servers.name] table.');
    next = raw;
    for (const [start, end] of ranges.reverse()) next = next.slice(0, start) + next.slice(end);
    next = next.trimEnd() + '\n\n' + toml.stringify({ mcp_servers: { [keys[1]]: value } } as Parameters<typeof toml.stringify>[0]);
  }
  if (!isDeepStrictEqual(parseConfig(next, format), expected)) throw new Error('Cannot preserve this configuration layout safely; nothing was changed.');
  return next;
}
