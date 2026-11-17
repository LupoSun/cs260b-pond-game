import { io as createClient, type Socket } from 'socket.io-client';
import { createPondServer } from '../src/server/createServer.js';
import type {
  AckResponse,
  CalibrationSummary,
  NetworkPresentationMode,
  PlayerPrivateSeat,
  SessionPublicSnapshot,
} from '../src/shared/types.js';

interface ScenarioMetrics {
  networkMode: NetworkPresentationMode;
  addedRttMs: number;
  jitterMs: number;
  durationMs: number;
  playersConnected: number;
  previewsSent: number;
  strokesSubmitted: number;
  strokesAccepted: number;
  duplicateOrStaleRejected: number;
  ackLatencyP50Ms: number;
  ackLatencyP95Ms: number;
  ackLatencyMaxMs: number;
  pauseCommandAckMs: number;
  meanTeamProgress: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return Number(sorted[idx].toFixed(1));
}

async function runLoadScenario(opts: {
  networkMode: NetworkPresentationMode;
  addedRttMs: number;
  jitterMs: number;
  activePlayMs: number;
}): Promise<ScenarioMetrics> {
  const server = await createPondServer({
    port: 0,
    host: '127.0.0.1',
    hostPasscode: 'rehearsal-pass',
    generatedDevPasscode: false,
    publicBaseUrl: 'http://127.0.0.1',
    enableDevSim: false,
  });

  const baseUrl = `http://127.0.0.1:${server.port}`;
  const hostSocket = createClient(baseUrl, { transports: ['websocket'] });
  const screenSocket = createClient(baseUrl, { transports: ['websocket'] });

  const playerBundles: Array<{
    socket: Socket;
    seat: PlayerPrivateSeat;
  }> = [];

  try {
    await new Promise<void>((resolve) => hostSocket.once('connect', () => resolve()));
    await new Promise<void>((resolve) => screenSocket.once('connect', () => resolve()));

    await new Promise<AckResponse>((resolve) => {
      hostSocket.emit('host.auth', { passcode: 'rehearsal-pass' }, resolve);
    });

    await new Promise<AckResponse>((resolve) => {
      hostSocket.emit(
        'host.command',
        {
          commandId: `mode_${opts.networkMode}`,
          type: 'set_network_mode',
          networkMode: opts.networkMode,
        },
        resolve,
      );
    });

    // Connect 30 distinct player sockets across 6 teams of 5
    const cal: CalibrationSummary = {
      version: 1,
      validated: true,
      stationaryBias: { x: 0, y: 0, z: 0 },
      stationaryNoiseRms: 0.07,
      onsetThreshold: 1.35,
      minPeakSignal: 2.2,
      measuredSampleRateHz: 60,
      hasLinearAcceleration: true,
    };

    for (let teamNum = 1; teamNum <= 6; teamNum++) {
      for (let slot = 0; slot < 5; slot++) {
        const ps = createClient(baseUrl, { transports: ['websocket'] });
        await new Promise<void>((resolve) => ps.once('connect', () => resolve()));
        const joinRes = await new Promise<AckResponse<PlayerPrivateSeat>>((resolve) => {
          ps.emit('player.join', { teamNumber: teamNum, playerName: `Bot ${teamNum}-${slot + 1}` }, resolve);
        });
        if (!joinRes.ok || !joinRes.data) {
          throw new Error(`Failed joining player ${teamNum}-${slot}: ${joinRes.message}`);
        }
        const calRes = await new Promise<AckResponse<{ calibrationVersion: number }>>((resolve) => {
          ps.emit(
            'calibration.complete',
            {
              assignmentVersion: joinRes.data!.assignment.assignmentVersion,
              calibration: cal,
              inputMethod: 'physical_sweep',
            },
            resolve,
          );
        });
        playerBundles.push({
          socket: ps,
          seat: {
            ...joinRes.data,
            calibrated: true,
            calibrationVersion: calRes.data!.calibrationVersion,
          },
        });
      }
    }

    // Load & start Straight Race
    await new Promise<AckResponse>((resolve) => {
      hostSocket.emit(
        'host.command',
        { commandId: 'load_sr', type: 'load_phase', phase: 'straight' },
        resolve,
      );
    });
    await new Promise<AckResponse>((resolve) => {
      hostSocket.emit(
        'host.command',
        { commandId: 'start_sr', type: 'start_phase' },
        resolve,
      );
    });

    // Wait out 3s shared countdown
    await sleep(3100);

    let previewsSent = 0;
    let strokesSubmitted = 0;
    let strokesAccepted = 0;
    let duplicateOrStaleRejected = 0;
    const ackLatencies: number[] = [];

    let latestSnap: SessionPublicSnapshot = server.session.getPublicSnapshot();
    screenSocket.on('session.snapshot', (s: SessionPublicSnapshot) => {
      latestSnap = s;
    });

    const startPlayMs = performance.now();
    let seq = 0;

    // 20 Hz preview loop (50ms) when in continuous mode + ~1 stroke/sec/player with added RTT + jitter
    while (performance.now() - startPlayMs < opts.activePlayMs) {
      seq += 1;

      for (let idx = 0; idx < playerBundles.length; idx++) {
        const bundle = playerBundles[idx];
        if (!bundle.socket.connected) continue;

        const attemptId = `load_att_${idx}_${Math.floor(seq / 20)}`;

        if (opts.networkMode === 'continuous') {
          previewsSent += 1;
          const oneWayDelay =
            opts.addedRttMs > 0
              ? Math.max(0, opts.addedRttMs / 2 + (Math.random() * 2 - 1) * opts.jitterMs)
              : 0;
          const emitPreview = () => {
            if (!bundle.socket.connected) return;
            bundle.socket.volatile.emit('input.preview', {
              attemptId,
              attemptSeq: seq,
              sessionId: latestSnap.sessionId,
              roundId: latestSnap.round.roundId,
              inputEpoch: latestSnap.inputEpoch,
              connectionGeneration: bundle.seat.connectionGeneration,
              progress: (seq % 20) / 20,
            });
          };
          if (oneWayDelay > 0) setTimeout(emitPreview, oneWayDelay);
          else emitPreview();
        }

        // Staggered completed stroke (~1 stroke/sec/player -> 30 strokes/sec total)
        if ((seq + idx) % 20 === 0 && latestSnap.runStatus === 'running') {
          strokesSubmitted += 1;
          const strokeId = `load_stk_${idx}_${seq}`;
          const snapAtPress = latestSnap;
          const sentAt = performance.now();
          const simulatedRtt =
            opts.addedRttMs > 0
              ? Math.max(0, opts.addedRttMs + (Math.random() * 2 - 1) * opts.jitterMs)
              : 0;

          setTimeout(() => {
            if (!bundle.socket.connected) return;
            bundle.socket.emit(
              'stroke.complete',
              {
                strokeId,
                attemptId: `stk_att_${idx}_${seq}`,
                attemptSeq: seq,
                sessionId: snapAtPress.sessionId,
                roundId: snapAtPress.round.roundId,
                inputEpoch: snapAtPress.inputEpoch,
                connectionGeneration: bundle.seat.connectionGeneration,
                calibrationVersion: bundle.seat.calibrationVersion,
                gestureId: bundle.seat.assignment.gestureId,
                inputMethod: 'physical_sweep',
                durationMs: 340,
                clientCompletedAtMs: sentAt,
              },
              (ack: AckResponse) => {
                const totalLatency = performance.now() - sentAt;
                ackLatencies.push(totalLatency);
                if (ack?.ok) strokesAccepted += 1;
                else duplicateOrStaleRejected += 1;
              },
            );
          }, simulatedRtt / 2);
        }
      }

      // Mid-scenario: test one player disconnect + resume AND host pause/resume responsiveness!
      if (seq === 25) {
        const target = playerBundles[0];
        target.socket.disconnect();
        setTimeout(() => {
          target.socket.connect();
          target.socket.once('connect', () => {
            target.socket.emit(
              'player.resume',
              { resumeToken: target.seat.resumeToken },
              (res: AckResponse<PlayerPrivateSeat>) => {
                if (res?.ok && res.data) {
                  target.seat = res.data;
                }
              },
            );
          });
        }, 120);
      }

      await sleep(50);
    }

    // Measure facilitator pause command turnaround under load
    const tPause0 = performance.now();
    await new Promise<AckResponse>((resolve) => {
      hostSocket.emit(
        'host.command',
        { commandId: 'pause_check', type: 'pause_phase' },
        resolve,
      );
    });
    const pauseCommandAckMs = Number((performance.now() - tPause0).toFixed(1));

    // Wait briefly for in-flight delayed strokes to settle and confirm pre-pause strokes after pause are rejected
    await sleep(Math.max(150, opts.addedRttMs + 100));

    const finalSnap = server.session.getPublicSnapshot();
    const meanTeamProgress = Number(
      (
        finalSnap.teams.reduce((s, t) => s + t.sim.laneProgress, 0) / finalSnap.teams.length
      ).toFixed(1),
    );

    ackLatencies.sort((a, b) => a - b);

    return {
      networkMode: opts.networkMode,
      addedRttMs: opts.addedRttMs,
      jitterMs: opts.jitterMs,
      durationMs: opts.activePlayMs,
      playersConnected: playerBundles.length,
      previewsSent,
      strokesSubmitted,
      strokesAccepted,
      duplicateOrStaleRejected,
      ackLatencyP50Ms: percentile(ackLatencies, 0.5),
      ackLatencyP95Ms: percentile(ackLatencies, 0.95),
      ackLatencyMaxMs: percentile(ackLatencies, 1.0),
      pauseCommandAckMs,
      meanTeamProgress,
    };
  } finally {
    hostSocket.disconnect();
    screenSocket.disconnect();
    for (const b of playerBundles) {
      b.socket.disconnect();
    }
    await server.close();
  }
}

async function main(): Promise<void> {
  console.log('=== CS260B Pond Game — Section 14.4 30-Player Network/Load Rehearsal ===');
  const results: ScenarioMetrics[] = [];

  const configs: Array<{
    networkMode: NetworkPresentationMode;
    addedRttMs: number;
    jitterMs: number;
    activePlayMs: number;
  }> = [
    { networkMode: 'continuous', addedRttMs: 0, jitterMs: 0, activePlayMs: 2500 },
    { networkMode: 'stroke_events', addedRttMs: 0, jitterMs: 0, activePlayMs: 2500 },
    { networkMode: 'continuous', addedRttMs: 100, jitterMs: 20, activePlayMs: 2500 },
    { networkMode: 'continuous', addedRttMs: 250, jitterMs: 35, activePlayMs: 2500 },
    { networkMode: 'continuous', addedRttMs: 500, jitterMs: 50, activePlayMs: 2500 },
  ];

  for (const cfg of configs) {
    const metrics = await runLoadScenario(cfg);
    results.push(metrics);
    console.log(JSON.stringify(metrics));
  }

  console.table(results);
}

main().catch((err) => {
  console.error('Load rehearsal failed:', err);
  process.exit(1);
});
