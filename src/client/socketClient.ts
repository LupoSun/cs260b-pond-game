import { io, type Socket } from 'socket.io-client';

/**
 * Creates a Socket.IO client configured so gameplay strokes are NEVER silently queued offline
 * by Socket.IO's disconnected packet buffer (Section 12.5).
 */
export function createPondSocket(): Socket {
  return io({
    path: '/socket.io',
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 400,
    reconnectionDelayMax: 2500,
  });
}

export function makeCommandId(prefix = 'cmd'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}
