// Docker CI fixture: kill this host process to prove cleanup is independent.
import { containerTransport } from '../../src/lib/cairn/container';
async function main() {
const transport = await containerTransport({
  command: '/usr/local/bin/node', args: ['/probe.mjs', '/host-canary-not-mounted', '9'],
  isolation: { image: process.env.CAIRN_CONTAINER_TEST_IMAGE!, maxLifetimeSeconds: Number(process.env.CAIRN_CONTAINER_WORKER_LIFETIME ?? 3) },
});
transport.onmessage = (m) => {
  if ('method' in m && m.method === 'containment_probe') process.stdout.write('ready\n');
};
transport.onerror = (e) => { process.stderr.write(e.message); process.exit(1); };
await transport.start();

}
void main().catch((e: Error) => { process.stderr.write(e.message); process.exit(1); });
