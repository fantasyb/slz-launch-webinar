import fs from 'node:fs';
import net from 'node:net';
const [hostFile, hostPort] = process.argv.slice(2);
const denied = (fn) => { try { fn(); return false; } catch { return true; } };
const connect = (host, port) => new Promise((resolve) => {
  const socket = net.connect({ host, port });
  const done = (reachable) => { socket.destroy(); resolve(reachable); };
  socket.on('connect', () => done(true));
  socket.on('error', () => done(false));
  socket.setTimeout(1000, () => done(false));
});
fs.writeFileSync('/tmp/private', 'scratch');
const result = {
  uid: process.getuid(),
  hostReadDenied: denied(() => fs.readFileSync(hostFile)),
  rootWriteDenied: (() => {
    try { fs.writeFileSync('/write-probe/escape', 'bad'); return false; }
    catch (e) { return e.code === 'EROFS'; }
  })(),
  dockerSocketDenied: denied(() => fs.statSync('/var/run/docker.sock')),
  ambientAbsent: process.env.CAIRN_CONTAINER_AMBIENT === undefined,
  explicit: process.env.ALLOWED_FIXTURE,
  scratch: fs.readFileSync('/tmp/private', 'utf8'),
  hostReachable: await connect('127.0.0.1', Number(hostPort)),
  externalReachable: await connect('192.0.2.1', 9),
  memoryMax: fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim(),
  swapMax: fs.readFileSync('/sys/fs/cgroup/memory.swap.max', 'utf8').trim(),
  pidsMax: fs.readFileSync('/sys/fs/cgroup/pids.max', 'utf8').trim(),
  cpuMax: fs.readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim(),
  status: fs.readFileSync('/proc/self/status', 'utf8').match(/^(?:NoNewPrivs|Seccomp|CapEff):.*$/gm),
};
process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'containment_probe', params: result }) + '\n');
// Remain alive so cleanup and the host-side lifetime bound are exercised.
setInterval(() => {}, 1000);
