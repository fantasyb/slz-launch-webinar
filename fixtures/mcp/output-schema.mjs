/**
 * An upstream that declares `outputSchema` and does not honour it.
 *
 *   node fixtures/mcp/output-schema.mjs
 *
 * Raw JSON-RPC on stdio, deliberately NOT built on the SDK's McpServer. That
 * is the whole point: McpServer validates its own output before sending, so a
 * fixture built on it turns this into a plain error from the server and
 * reproduces nothing. A server written in Python, in Go, or by hand does not
 * self-validate, and the mismatch reaches the caller.
 *
 * Structured output is the newest part of the tool contract and the most
 * likely thing a real server does that a fixture written here does not. It
 * matters to a proxy specifically, because a proxy is a client on one side and
 * a server on the other, and the SDK's CLIENT enforces the output contract:
 * given a tool that declared a schema, `callTool` throws when the result has
 * no structuredContent. A relay that calls `callTool` therefore applies the
 * real client's check on its behalf, and fails a call the client would have
 * accepted. See cairn-0048 and the note at the call site in mcp-proxy.ts.
 */
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    const send = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\n');
    if (m.method === 'initialize') {
      send({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'output-schema-fixture', version: '1.0.0' } });
    } else if (m.method === 'tools/list') {
      send({
        tools: [
          {
            name: 'strict_textonly',
            description: 'Declares an output schema and returns only text, as a server not written on this SDK does',
            inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
            outputSchema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] },
          },
          {
            name: 'plain',
            description: 'Declares no output schema',
            inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
          },
        ],
      });
    } else if (m.method === 'tools/call') {
      send({ content: [{ type: 'text', text: 'two' }] });
    } else if (m.id !== undefined) {
      send({});
    }
  }
});
