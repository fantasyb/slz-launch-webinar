import net from 'node:net';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { JSONRPCMessageSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { readFrames, frameWriter, SUPERVISOR_SOCKET } from './supervisor-wire';

/** No child process, Docker, catalog, credential store, or recovery API here. */
export class SupervisorClientTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;
  private socket?: net.Socket;
  private write?: (value: unknown) => void;
  private started = false;
  private ready = false;
  private ended = false;
  constructor(private readonly workload: string, private readonly socketPath = SUPERVISOR_SOCKET) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(workload)) throw new Error('Invalid supervisor workload ID');
  }
  async start(): Promise<void> {
    if (this.started || this.ended) throw new Error('Supervisor transport cannot restart');
    this.started = true;
    const socket = this.socket = net.createConnection(this.socketPath);
    this.write = frameWriter(socket);
    socket.on('error', () => {});
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.destroy(new Error('Supervisor connection timed out')); }, 20000);
      const pump = async () => {
        try {
          await new Promise<void>((connected, failed) => {
            socket.once('connect', connected);
            socket.once('error', failed);
            socket.once('close', () => failed(new Error('Supervisor unavailable')));
          });
          this.write!({ workload: this.workload });
          let first = true;
          for await (const frame of readFrames(socket)) {
            if (this.ended) break;
            if (first) {
              if (!frame || typeof frame !== 'object' || Array.isArray(frame)
                || Object.keys(frame).length !== 1 || (frame as { ready?: unknown }).ready !== true) throw new Error('Supervisor refused session');
              first = false; this.ready = true; clearTimeout(timer); resolve();
            } else this.onmessage?.(JSONRPCMessageSchema.parse(frame));
          }
          if (first) throw new Error('Supervisor refused session');
        } catch (error) {
          this.ready = false;
          if (!this.ended) this.onerror?.(new Error('Supervisor session failed'));
          reject(error);
        } finally {
          clearTimeout(timer);
          void this.close();
        }
      };
      void pump();
    });
  }
  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.ready || this.ended) throw new Error('Supervisor session is closed');
    try { this.write!(JSONRPCMessageSchema.parse(message)); }
    catch (error) { await this.close(); throw error; }
  }
  async close(): Promise<void> {
    if (this.ended) return;
    this.ended = true; this.ready = false;
    this.socket?.destroy();
    this.onclose?.();
  }
}
