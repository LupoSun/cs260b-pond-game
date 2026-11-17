import { io as createClient } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';
import { createPondServer, type RunningPondServer } from '../src/server/createServer.js';
import type { AckResponse, SessionPublicSnapshot } from '../src/shared/types.js';

describe('Section 14.2 & 14.3 — Live Socket.IO Trust Boundaries & Role Isolation', () => {
  let server: RunningPondServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  it('rejects unauthorized host commands on public/display sockets, keeps non-players out of seats, and sanitizes snapshots', async () => {
    server = await createPondServer({
      port: 0,
      host: '127.0.0.1',
      hostPasscode: 'test-secret-pass',
      generatedDevPasscode: false,
      publicBaseUrl: 'https://pond.example.edu',
      enableDevSim: false,
    });

    const url = `http://127.0.0.1:${server.port}`;
    const screenClient = createClient(url, { transports: ['websocket'] });
    const hostClient = createClient(url, { transports: ['websocket'] });
    const playerClient = createClient(url, { transports: ['websocket'] });

    try {
      const initialSnap = await new Promise<SessionPublicSnapshot>((resolve) => {
        screenClient.once('session.snapshot', resolve);
      });
      expect(initialSnap.devSimAvailable).toBe(false);
      expect(initialSnap.teams).toHaveLength(0);

      // Classroom display attempting an unauthorized host command MUST be rejected
      const unauthAck = await new Promise<AckResponse>((resolve) => {
        screenClient.emit(
          'host.command',
          { commandId: 'evil_1', type: 'load_phase', phase: 'training' },
          resolve,
        );
      });
      expect(unauthAck.ok).toBe(false);
      expect(unauthAck.code).toBe('UNAUTHORIZED');

      // Wrong passcode rejected
      const badAuth = await new Promise<AckResponse>((resolve) => {
        hostClient.emit('host.auth', { passcode: 'wrong-pass' }, resolve);
      });
      expect(badAuth.ok).toBe(false);
      expect(badAuth.code).toBe('INVALID_PASSCODE');

      // Correct passcode unlocks Mission Control without consuming a player seat
      const goodAuth = await new Promise<AckResponse>((resolve) => {
        hostClient.emit('host.auth', { passcode: 'test-secret-pass' }, resolve);
      });
      expect(goodAuth.ok).toBe(true);

      // Join 1 player and inspect raw public snapshot JSON to ensure resumeToken & hostPasscode never leak
      const joinAck = await new Promise<AckResponse<{ resumeToken: string }>>((resolve) => {
        playerClient.emit('player.join', { teamNumber: 1, playerName: 'Tester' }, resolve);
      });
      expect(joinAck.ok).toBe(true);
      const secretResumeToken = joinAck.data!.resumeToken;

      const nextPublicSnap = server.session.getPublicSnapshot();
      const serialized = JSON.stringify(nextPublicSnap);
      expect(serialized).not.toContain(secretResumeToken);
      expect(serialized).not.toContain('test-secret-pass');
      expect(nextPublicSnap.teams).toHaveLength(1);
      expect(nextPublicSnap.teams[0].joinedCount).toBe(1);
    } finally {
      screenClient.disconnect();
      hostClient.disconnect();
      playerClient.disconnect();
    }
  });
});
