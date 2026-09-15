import net from 'node:net';
import { pathToFileURL } from 'node:url';

/** A successful result requires the expected witness bytes, not just a socket. */
export function reachWitness(host, port, token) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let received = '';
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.on('data', (chunk) => {
      received += chunk.toString('utf8');
      if (received.length > token.length) done(false);
      else if (received === token) done(true);
    });
    socket.on('error', () => done(false));
    socket.on('end', () => done(received === token));
    socket.setTimeout(2000, () => done(false));
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [host, port, token] = process.argv.slice(2);
  const ok = await reachWitness(host, Number(port), token);
  console.log(JSON.stringify({ reachable: ok }));
  process.exitCode = ok ? 0 : 1;
}
