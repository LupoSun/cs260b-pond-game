import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import QRCode from 'qrcode';
import { Server as SocketIOServer } from 'socket.io';
import { GAME_DEFAULTS } from '../shared/constants.js';
import type {
  AckResponse,
  CalibrationSummary,
  HostCommandPayload,
  InputBeginPayload,
  InputEndPayload,
  InputMethod,
  InputPreviewPayload,
  SensorStatus,
  StrokeCompletePayload,
} from '../shared/types.js';
import type { ServerConfig } from './config.js';
import { ClassroomGameSession } from './gameSession.js';

export interface RunningPondServer {
  app: express.Express;
  httpServer: http.Server;
  io: SocketIOServer;
  session: ClassroomGameSession;
  port: number;
  close: () => Promise<void>;
}

function safePasscodeEquals(provided: string, expected: string): boolean {
  const a = Buffer.from(provided || '', 'utf8');
  const b = Buffer.from(expected || '', 'utf8');
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function createPondServer(config: ServerConfig): Promise<RunningPondServer> {
  const app = express();
  app.use(express.json({ limit: '32kb' }));

  const httpServer = http.createServer(app);
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: true,
      methods: ['GET', 'POST'],
    },
    pingInterval: 10000,
    pingTimeout: 10000,
  });

  const authorizedHostSockets = new Set<string>();

  const session = new ClassroomGameSession({
    publicBaseUrl: config.publicBaseUrl,
    devSimAvailable: config.enableDevSim,
    callbacks: {
      onStrokeAccepted: (ev) => {
        io.to('public').to('hosts').emit('stroke.accepted', ev);
      },
      onItemCollected: (ev) => {
        io.to('public').to('hosts').emit('item.collected', ev);
      },
      onPlayerRecalibrate: (_playerId, socketId, minCalVersion) => {
        if (socketId) {
          io.to(socketId).emit('player.recalibrate', { minCalibrationVersion: minCalVersion });
        }
      },
      onPlayerSuperseded: (oldSocketId) => {
        io.to(oldSocketId).emit('player.superseded', {
          message: 'This seat was resumed in another tab or window.',
        });
      },
      onSessionCleared: () => {
        io.emit('session.cleared', { sessionId: session.getSessionId() });
      },
      onPhaseOrStatusChanged: (snapshot) => {
        io.to('public').emit('session.snapshot', snapshot);
        if (authorizedHostSockets.size > 0) {
          io.to('hosts').emit('host.snapshot', session.getHostSnapshot());
        }
      },
    },
  });

  // Health & QR endpoints (never leak secrets or private player credentials)
  app.get('/api/health', (_req, res) => {
    const snap = session.getPublicSnapshot();
    res.json({
      ok: true,
      sessionId: snap.sessionId,
      phase: snap.phase,
      runStatus: snap.runStatus,
      networkMode: snap.networkMode,
      teams: snap.teams.length,
      uptimeSec: Math.round(process.uptime()),
    });
  });

  app.get('/api/qr', async (req, res) => {
    const targetUrl = String(req.query.url || '').trim();
    if (!targetUrl || targetUrl.length > 400 || !/^https?:\/\//i.test(targetUrl)) {
      res.status(400).json({ ok: false, error: 'Valid http(s) url query parameter required.' });
      return;
    }
    try {
      const svg = await QRCode.toString(targetUrl, {
        type: 'svg',
        margin: 1,
        color: { dark: '#0b2b2e', light: '#ffffff' },
      });
      res.setHeader('Content-Type', 'image/svg+xml');
      res.send(svg);
    } catch {
      res.status(500).json({ ok: false, error: 'Failed to generate QR SVG.' });
    }
  });

  // Serve built Vite SPA in production or whenever dist/client exists
  const clientDistDir = path.resolve(process.cwd(), 'dist/client');
  if (fs.existsSync(clientDistDir)) {
    app.use('/assets', express.static(path.join(clientDistDir, 'assets'), { immutable: true, maxAge: '7d' }));
    app.use(express.static(clientDistDir, { index: false, maxAge: 0 }));
    app.get(['/', '/play', '/screen', '/control', '/lab'], (_req, res) => {
      res.setHeader('Cache-Control', 'no-store, must-revalidate');
      res.sendFile(path.join(clientDistDir, 'index.html'));
    });
  }

  io.on('connection', (socket) => {
    // Public snapshot room: read-only sanitized state (no resume tokens, no host credentials)
    socket.join('public');
    socket.emit('session.snapshot', session.getPublicSnapshot());

    socket.on(
      'connection.probe',
      (
        payload: { clientSentAtMs: number; lastMeasuredRttMs?: number },
        ack?: (resp: { serverNowMs: number; clientSentAtMs: number }) => void,
      ) => {
        const res = session.recordConnectionProbe(socket.id, payload || { clientSentAtMs: 0 });
        ack?.(res);
      },
    );

    // Participant events
    socket.on(
      'player.join',
      (payload: { teamNumber: number }, ack?: (resp: AckResponse<unknown>) => void) => {
        const res = session.joinPlayer(socket.id, Number(payload?.teamNumber));
        ack?.(res);
        broadcastImmediate();
      },
    );

    socket.on(
      'player.resume',
      (payload: { resumeToken: string }, ack?: (resp: AckResponse<unknown>) => void) => {
        const res = session.resumePlayer(socket.id, String(payload?.resumeToken || ''));
        ack?.(res);
        broadcastImmediate();
      },
    );

    socket.on(
      'sensor.status',
      (
        payload: { sensorStatus: SensorStatus; inputMethod?: InputMethod; note?: string },
        ack?: (resp: AckResponse) => void,
      ) => {
        const res = session.updateSensorStatus(socket.id, payload || { sensorStatus: 'unknown' });
        ack?.(res);
      },
    );

    socket.on(
      'calibration.complete',
      (
        payload: {
          assignmentVersion: number;
          calibration: CalibrationSummary;
          inputMethod: InputMethod;
        },
        ack?: (resp: AckResponse<{ calibrationVersion: number }>) => void,
      ) => {
        const res = session.completeCalibration(socket.id, payload);
        ack?.(res);
        broadcastImmediate();
      },
    );

    socket.on(
      'input.begin',
      (payload: InputBeginPayload, ack?: (resp: AckResponse) => void) => {
        const res = session.handleInputBegin(socket.id, payload);
        ack?.(res);
      },
    );

    socket.on('input.preview', (payload: InputPreviewPayload) => {
      session.handleInputPreview(socket.id, payload);
    });

    socket.on(
      'input.release',
      (payload: InputEndPayload, ack?: (resp: AckResponse) => void) => {
        const res = session.handleInputEnd(socket.id, payload);
        ack?.(res);
      },
    );

    socket.on(
      'input.cancel',
      (payload: InputEndPayload, ack?: (resp: AckResponse) => void) => {
        const res = session.handleInputEnd(socket.id, payload);
        ack?.(res);
      },
    );

    socket.on(
      'stroke.complete',
      (
        payload: StrokeCompletePayload,
        ack?: (resp: AckResponse<{ strokeId: string }>) => void,
      ) => {
        const res = session.handleStrokeComplete(socket.id, payload);
        ack?.(res);
      },
    );

    // Facilitator authentication & commands (server-enforced trust boundary)
    socket.on(
      'host.auth',
      (payload: { passcode: string }, ack?: (resp: AckResponse) => void) => {
        const provided = typeof payload?.passcode === 'string' ? payload.passcode.trim() : '';
        if (!safePasscodeEquals(provided, config.hostPasscode)) {
          ack?.({
            ok: false,
            code: 'INVALID_PASSCODE',
            message: 'Incorrect facilitator passcode.',
          });
          return;
        }
        authorizedHostSockets.add(socket.id);
        socket.join('hosts');
        socket.emit('host.snapshot', session.getHostSnapshot());
        ack?.({
          ok: true,
          code: 'AUTHENTICATED',
          message: 'Mission Control authenticated.',
          sessionId: session.getSessionId(),
        });
      },
    );

    socket.on(
      'host.command',
      (payload: HostCommandPayload, ack?: (resp: AckResponse) => void) => {
        if (!authorizedHostSockets.has(socket.id)) {
          ack?.({
            ok: false,
            code: 'UNAUTHORIZED',
            message: 'Mission Control authentication is required for facilitator commands.',
          });
          return;
        }
        const res = session.executeHostCommand(payload);
        ack?.(res);
        broadcastImmediate();
      },
    );

    socket.on('disconnect', () => {
      authorizedHostSockets.delete(socket.id);
      session.handleSocketDisconnect(socket.id);
    });
  });

  function broadcastImmediate(): void {
    io.to('public').emit('session.snapshot', session.getPublicSnapshot());
    if (authorizedHostSockets.size > 0) {
      io.to('hosts').emit('host.snapshot', session.getHostSnapshot());
    }
  }

  // Fixed-timestep simulation loop
  let lastTickMs = performance.now();
  const simInterval = setInterval(() => {
    const now = performance.now();
    const dt = Math.min(100, Math.max(1, now - lastTickMs));
    lastTickMs = now;
    session.stepSimulation(dt);
  }, Math.round(GAME_DEFAULTS.simTickMs));

  // Periodic latest-only state snapshot broadcast (~15 Hz)
  const snapshotInterval = setInterval(() => {
    io.to('public').volatile.emit('session.snapshot', session.getPublicSnapshot());
    if (authorizedHostSockets.size > 0) {
      io.to('hosts').volatile.emit('host.snapshot', session.getHostSnapshot());
    }
  }, GAME_DEFAULTS.snapshotBroadcastMs);

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.port, config.host, () => resolve());
  });

  const addr = httpServer.address();
  const boundPort = typeof addr === 'object' && addr ? addr.port : config.port;

  return {
    app,
    httpServer,
    io,
    session,
    port: boundPort,
    close: async () => {
      clearInterval(simInterval);
      clearInterval(snapshotInterval);
      await new Promise<void>((resolve) => io.close(() => resolve()));
      if (httpServer.listening) {
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      }
    },
  };
}
