import net from 'node:net';
import fs from 'node:fs';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';
import { SupervisorAdmission, type AdmissionReservation } from './supervisor-admission';
import { readFrames, frameWriter, FRAME_BYTES } from './supervisor-wire';

interface Runtime {
  launch(lease: AdmissionReservation): Promise<Transport>;
}

/** Policy, admission and runtime are trusted local objects, never wire inputs.
 * A connection can open ONE approved workload and exchange MCP messages with it.
 * Disconnect owns teardown; there are no caller-selectable container/session IDs. */
export async function serveSupervisor(socketPath: string, admission: SupervisorAdmission, runtime: Runtime) {
  const sockets = new Set<net.Socket>();
  const tasks = new Set<Promise<void>>();
  let stopping = false;
  let cleanupUncertain = false;
  const failAdmission = () => { cleanupUncertain = true; admission.cleanupFailed(); };
  const server = net.createServer({ highWaterMark: 16384 }, (socket) => {
    if (stopping || sockets.size >= 64) { socket.destroy(); return; }
    sockets.add(socket);
    // Socket errors are deliberately not reflected with runtime error text,
    // which may include operator-owned arguments or environment information.
    socket.on('error', () => {});
    const task = handle(socket).finally(() => { sockets.delete(socket); tasks.delete(task); });
    tasks.add(task);
  });

  async function handle(socket: net.Socket): Promise<void> {
    let lease: AdmissionReservation | undefined, transport: Transport | undefined;
    let timer = setTimeout(() => socket.destroy(), 2000);
    let ready = false, pendingBytes = 0;
    const pending: unknown[] = [];
    const write = frameWriter(socket);
    try {
      const frames = readFrames(socket);
      const first = await frames.next();
      if (first.done) return;
      lease = admission.reserve(first.value); // strict {workload}, no overrides
      clearTimeout(timer);
      timer = setTimeout(() => socket.destroy(), 60000);
      // If the peer disconnects during creation, still await completion and
      // remove the result in finally. Never refund an uncertain creation.
      transport = await runtime.launch(lease);
      if (socket.destroyed) return;
      transport.onmessage = (message) => {
        if (socket.destroyed) return;
        try {
          if (!ready) {
            pendingBytes += Buffer.byteLength(JSON.stringify(message));
            if (pendingBytes > FRAME_BYTES || pending.length >= 1000) throw new Error('Startup output limit');
            pending.push(message);
          } else write(message);
        } catch { socket.destroy(); }
      };
      transport.onerror = () => socket.destroy(); // runtime owns fault quarantine
      transport.onclose = () => socket.destroy();
      await transport.start();
      if (socket.destroyed) return;
      clearTimeout(timer);
      write({ ready: true });
      ready = true;
      for (const message of pending) write(message);
      pending.length = 0;
      for await (const frame of frames) {
        if (socket.destroyed) break;
        // Malformed gateway input closes its session, not the workload's
        // quarantine: an untrusted caller cannot manufacture upstream faults.
        await transport.send(JSONRPCMessageSchema.parse(frame));
      }
    } catch {
      // Close without leaking private specs or daemon error strings.
    } finally {
      clearTimeout(timer);
      socket.destroy();
      if (lease) {
        if (!transport) failAdmission(); // creation outcome uncertain
        else {
          try { await transport.close(); admission.confirmRemoved(lease); }
          catch { failAdmission(); }
        }
      }
    }
  }

  // Never unlink an existing path to make startup pass. A stale socket requires
  // safe operator reconciliation, not blind replacement by another instance.
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => { server.off('error', reject); resolve(); });
  });
  try { fs.chmodSync(socketPath, 0o660); }
  catch (error) { await new Promise<void>((resolve) => server.close(() => resolve())); throw error; }
  server.on('error', failAdmission);
  return {
    async close() {
      stopping = true;
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const socket of sockets) socket.destroy();
      await Promise.all([...tasks]);
      await closed;
      if (cleanupUncertain) throw new Error('Supervisor cleanup uncertain; operator recovery required');
    },
  };
}
