import type { Socket } from 'node:net';

export const SUPERVISOR_SOCKET = '/run/cairn-supervisor/control.sock';
export const FRAME_BYTES = 1024 * 1024;
const SESSION_BYTES = 16 * FRAME_BYTES;
const SESSION_FRAMES = 10000;

/** Bounded newline framing. One iterator owns reads; waiting for the runtime
 * applies socket backpressure instead of growing an unbounded message queue. */
export async function* readFrames(socket: Socket): AsyncGenerator<unknown> {
  let pending = Buffer.alloc(0), bytes = 0, frames = 0;
  for await (const chunk of socket) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += data.length;
    if (bytes > SESSION_BYTES) throw new Error('Session byte limit exceeded');
    pending = Buffer.concat([pending, data]);
    let end: number;
    while ((end = pending.indexOf(10)) !== -1) {
      const limit = frames === 0 ? 4096 : FRAME_BYTES;
      if (end > limit || ++frames > SESSION_FRAMES) throw new Error('Frame limit exceeded');
      const line = pending.subarray(0, end);
      pending = pending.subarray(end + 1);
      yield JSON.parse(line.toString('utf8'));
    }
    if (pending.length > (frames === 0 ? 4096 : FRAME_BYTES)) throw new Error('Frame limit exceeded');
  }
  if (pending.length) throw new Error('Truncated frame');
}

/** Independent budget per direction, including queued writes to a slow peer. */
export function frameWriter(socket: Socket): (value: unknown) => void {
  let bytes = 0, frames = 0;
  return (value) => {
    const line = JSON.stringify(value) + '\n';
    const size = Buffer.byteLength(line);
    bytes += size;
    if (socket.destroyed || size > FRAME_BYTES || bytes > SESSION_BYTES || ++frames > SESSION_FRAMES
      || socket.writableLength + size > FRAME_BYTES) throw new Error('Output limit exceeded or session closed');
    socket.write(line);
  };
}
