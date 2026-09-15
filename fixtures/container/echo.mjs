import readline from 'node:readline';
for await (const line of readline.createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (m.id === undefined) continue;
  let result = {};
  if (m.method === 'initialize') result = { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'isolated-echo', version: '1' } };
  if (m.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Echo fixture', inputSchema: { type: 'object', properties: {} } }] };
  if (m.method === 'tools/call') result = { content: [{ type: 'text', text: 'isolated-echo-ok' }] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\n');
}
