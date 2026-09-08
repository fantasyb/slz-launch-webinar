// Emit a protocol fault followed by valid data in the SAME chunk. Revocation
// must happen before the buffered second frame can reach the gateway.
process.stdout.write('not JSON\n' + JSON.stringify({jsonrpc: '2.0', method: 'after_fault', params: { unsafe: true }}) + '\n');
setInterval(() => {}, 1000);
