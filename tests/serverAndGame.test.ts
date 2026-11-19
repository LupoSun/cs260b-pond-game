import { describe, expect, it } from 'vitest';
import { ClassroomGameSession } from '../src/server/gameSession.js';
import {
  GAME_DEFAULTS,
  GUIDE_STEPS,
  MUSIC_VOLUME_DEFAULT,
  PLAYER_EMOJI_POOL,
  POND_ITEMS,
  SECTION_BUDGET_DEFAULTS_SEC,
  SECTION_ORDER,
  formatSectionClock,
  getSyncMultiplier,
  sectionForPhase,
} from '../src/shared/constants.js';
import type {
  AckResponse,
  CalibrationSummary,
  HostCommandPayload,
  PlayerPrivateSeat,
} from '../src/shared/types.js';

function makeValidCal(version = 1): CalibrationSummary {
  return {
    version,
    validated: true,
    stationaryBias: { x: 0, y: 0, z: 0 },
    stationaryNoiseRms: 0.08,
    onsetThreshold: 1.35,
    minPeakSignal: 2.2,
    measuredSampleRateHz: 60,
    hasLinearAcceleration: true,
  };
}

function joinAndCalibrate(
  session: ClassroomGameSession,
  socketId: string,
  teamNumber: number,
): PlayerPrivateSeat {
  const joined = session.joinPlayer(socketId, teamNumber, 'Tester');
  if (!joined.ok || !joined.data) {
    throw new Error(`Join failed: ${joined.code} ${joined.message}`);
  }
  const calRes = session.completeCalibration(socketId, {
    assignmentVersion: joined.data.assignment.assignmentVersion,
    calibration: makeValidCal(1),
    inputMethod: 'physical_sweep',
  });
  if (!calRes.ok || !calRes.data) {
    throw new Error(`Calibration failed: ${calRes.code}`);
  }
  return {
    ...joined.data,
    calibrated: true,
    calibrationVersion: calRes.data.calibrationVersion,
  };
}

/** Submits one completed stroke against the session's current round, epoch, and the seat's calibration. */
function stroke(
  session: ClassroomGameSession,
  socketId: string,
  seat: PlayerPrivateSeat,
  uniqueId: string,
): AckResponse<{ strokeId: string }> {
  const snap = session.getPublicSnapshot();
  return session.handleStrokeComplete(socketId, {
    strokeId: `stk_${uniqueId}`,
    attemptId: `att_${uniqueId}`,
    attemptSeq: 1,
    sessionId: snap.sessionId,
    roundId: snap.round.roundId,
    inputEpoch: snap.inputEpoch,
    connectionGeneration: seat.connectionGeneration,
    calibrationVersion: seat.calibrationVersion,
    gestureId: seat.assignment.gestureId,
    inputMethod: 'physical_sweep',
    durationMs: 300,
    clientCompletedAtMs: snap.serverNowMs,
  });
}

describe('Section 14.2 — Authoritative Server, Normalization, Scoring & Scoped Resets', () => {
  it('requires a nickname at join, sanitizes it, and keeps it across reconnect', () => {
    const session = new ClassroomGameSession();
    expect(session.joinPlayer('sock_noname', 1, undefined).code).toBe('INVALID_PLAYER_NAME');
    expect(session.joinPlayer('sock_blank', 1, '  \u200b ').code).toBe('INVALID_PLAYER_NAME');
    expect(session.getPublicSnapshot().teams.length).toBe(0);

    const joined = session.joinPlayer('sock_named', 1, '  Sam \n the   Extremely Long Frog  ');
    expect(joined.ok).toBe(true);
    expect(joined.data!.playerName).toBe('Sam the Extremel');
    expect(session.getPublicSnapshot().teams[0].limbs[0].playerName).toBe('Sam the Extremel');
    expect(session.getHostSnapshot().players[0].playerName).toBe('Sam the Extremel');

    session.handleSocketDisconnect('sock_named');
    const resumed = session.resumePlayer('sock_named_2', joined.data!.resumeToken);
    expect(resumed.data!.playerName).toBe('Sam the Extremel');
  });

  it('opens a fresh session on the guide, toggles it by host command, and hides it when a phase loads or starts', () => {
    const session = new ClassroomGameSession();
    expect(session.getPublicSnapshot().guideVisible).toBe(true);

    const show = (visible: boolean, id: string) =>
      session.executeHostCommand({ commandId: id, type: 'set_guide_visible', visible });

    expect(show(false, 'g0').ok).toBe(true);
    expect(session.getPublicSnapshot().guideVisible).toBe(false);
    expect(show(true, 'g1').ok).toBe(true);
    expect(session.getPublicSnapshot().guideVisible).toBe(true);

    // Loading a phase puts that phase on the display, so the guide steps aside
    session.executeHostCommand({ commandId: 'g2', type: 'load_phase', phase: 'training' });
    expect(session.getPublicSnapshot().guideVisible).toBe(false);

    // It can be brought back while the phase is only staged, and starting hides it again
    expect(show(true, 'g2b').ok).toBe(true);
    session.executeHostCommand({ commandId: 'g3', type: 'start_phase' });
    expect(session.getPublicSnapshot().runStatus).toBe('running');
    expect(session.getPublicSnapshot().guideVisible).toBe(false);

    const bogus = { commandId: 'g_bogus', type: 'not_a_command' } as unknown as HostCommandPayload;
    expect(session.executeHostCommand(bogus).code).toBe('UNKNOWN_COMMAND');

    expect(show(true, 'g4').code).toBe('MUST_PAUSE_OR_STAGE_FIRST');
    session.executeHostCommand({ commandId: 'g5', type: 'pause_phase' });
    expect(show(true, 'g6').ok).toBe(true);
    session.executeHostCommand({ commandId: 'g7', type: 'resume_phase' });
    expect(session.getPublicSnapshot().guideVisible).toBe(false);
  });

  it('starts with 0 lobby teams, dynamically spawns joined teams in sorted order, enforces universal min/max bounds and 30-player cap', () => {
    let clockMs = 1000;
    const session = new ClassroomGameSession({
      nowFn: () => clockMs,
      initialMinTeamSize: 4,
      initialMaxTeamSize: 6,
    });

    // Lobby starts with zero teams; only joined teams appear!
    expect(session.getPublicSnapshot().teams).toHaveLength(0);
    expect(session.getPublicSnapshot().minTeamSize).toBe(4);
    expect(session.getPublicSnapshot().maxTeamSize).toBe(6);

    // Out-of-range team numbers rejected cleanly
    expect(session.joinPlayer('sock_bad_0', 0, 'Tester').code).toBe('TEAM_NUMBER_OUT_OF_RANGE');
    expect(session.joinPlayer('sock_bad_99', 99, 'Tester').code).toBe('TEAM_NUMBER_OUT_OF_RANGE');
    expect(session.getPublicSnapshot().teams).toHaveLength(0);

    // Joining Team 4 then Team 1 spawns only those 2 teams in ascending order [1, 4]
    expect(session.joinPlayer('sock_4_1', 4, 'Tester').ok).toBe(true);
    expect(session.joinPlayer('sock_1_1', 1, 'Tester').ok).toBe(true);
    expect(session.getPublicSnapshot().teams.map((t) => t.teamNumber)).toEqual([1, 4]);
    expect(session.getPublicSnapshot().teams[0].isSizeValid).toBe(false); // 1 < minTeamSize(4)

    // Fill Team 1 up to maxTeamSize (6) -> 7th player on Team 1 rejected with TEAM_FULL (never silently redirected!)
    for (let s = 2; s <= 6; s++) {
      const res = session.joinPlayer(`sock_1_${s}`, 1, 'Tester');
      expect(res.ok).toBe(true);
      expect(res.data?.teamNumber).toBe(1);
    }
    expect(session.getPublicSnapshot().teams[0].isSizeValid).toBe(true);
    const extraOnTeam1 = session.joinPlayer('sock_overflow_team1', 1, 'Tester');
    expect(extraOnTeam1.ok).toBe(false);
    expect(extraOnTeam1.code).toBe('TEAM_FULL');

    // Lowering maxTeamSize below Team 1's existing 6 joined players is rejected
    const shrinkErr = session.executeHostCommand({
      commandId: 'bounds_too_low',
      type: 'set_team_size_bounds',
      minTeamSize: 3,
      maxTeamSize: 5,
    });
    expect(shrinkErr.ok).toBe(false);
    expect(shrinkErr.code).toBe('EXCEEDS_EXISTING_TEAM_SIZE');

    // Fill remaining seats across Teams 2, 3, 4, 5 up to 30 total players (6 on T1, 6 on T2, 6 on T3, 6 on T4, 6 on T5 = 30)
    for (let s = 2; s <= 6; s++) {
      expect(session.joinPlayer(`sock_4_${s}`, 4, 'Tester').ok).toBe(true);
    }
    for (const t of [2, 3, 5]) {
      for (let s = 1; s <= 6; s++) {
        expect(session.joinPlayer(`sock_${t}_${s}`, t, 'Tester').ok).toBe(true);
      }
    }

    expect(session.getPublicSnapshot().teams.map((t) => t.teamNumber)).toEqual([1, 2, 3, 4, 5]);

    // 31st distinct player attempting to spawn Team 6 rejected with SESSION_FULL
    const p31 = session.joinPlayer('sock_31', 6, 'Tester');
    expect(p31.ok).toBe(false);
    expect(p31.code).toBe('SESSION_FULL');
  });

  it('dynamically grows creature limbs as players join and enforces universal minTeamSize readiness warnings', () => {
    const session = new ClassroomGameSession({
      initialMinTeamSize: 3,
      initialMaxTeamSize: 5,
    });
    expect(session.getPublicSnapshot().teams).toHaveLength(0);

    const joinedSeats: PlayerPrivateSeat[] = [];
    for (let count = 1; count <= 5; count++) {
      const seat = joinAndCalibrate(session, `dyn_p${count}`, 1);
      joinedSeats.push(seat);

      const t1 = session.getPublicSnapshot().teams[0];
      expect(t1.limbCount).toBe(count);
      expect(t1.joinedCount).toBe(count);
      expect(t1.limbs).toHaveLength(count);
      expect(t1.isSizeValid).toBe(count >= 3 && count <= 5);

      // Every previously joined player keeps the exact same limbIndex and gestureId
      for (let prev = 0; prev < count; prev++) {
        expect(t1.limbs[prev].assignedPlayerId).toBe(joinedSeats[prev].playerId);
        expect(t1.limbs[prev].limbIndex).toBe(prev);
        expect(t1.limbs[prev].gestureId).toBe(joinedSeats[prev].assignment.gestureId);
      }

      if (count === 2) {
        // With 2 players (< minTeamSize 3), starting Straight Race requires readiness override unless minTeamSize is lowered
        session.executeHostCommand({ commandId: 'ld_2', type: 'load_phase', phase: 'straight' });
        const blocked = session.executeHostCommand({ commandId: 'st_2', type: 'start_phase' });
        expect(blocked.ok).toBe(false);
        expect(blocked.code).toBe('READINESS_WARNING_CONFIRM_REQUIRED');
        session.executeHostCommand({ commandId: 'back_tr', type: 'load_phase', phase: 'training' });
      }
    }

    // Now at 5 players (within [3, 5]) and all calibrated -> starts Straight Race cleanly with zero warnings!
    session.executeHostCommand({ commandId: 'ld_ok', type: 'load_phase', phase: 'straight' });
    const started = session.executeHostCommand({ commandId: 'st_ok', type: 'start_phase' });
    expect(started.ok).toBe(true);
  });

  it('allocates the final remaining seat atomically and supersedes duplicate controller tabs on resume', () => {
    const supersededSockets: string[] = [];
    const session = new ClassroomGameSession({
      initialMinTeamSize: 2,
      initialMaxTeamSize: 4,
      callbacks: {
        onPlayerSuperseded: (oldId) => supersededSockets.push(oldId),
      },
    });

    session.joinPlayer('s1', 1, 'Tester');
    session.joinPlayer('s2', 1, 'Tester');
    session.joinPlayer('s3', 1, 'Tester');

    // Two contenders for the single remaining seat on Team 1
    const rA = session.joinPlayer('s4_contender_A', 1, 'Tester');
    const rB = session.joinPlayer('s4_contender_B', 1, 'Tester');
    expect(rA.ok).toBe(true);
    expect(rB.ok).toBe(false);
    expect(rB.code).toBe('TEAM_FULL');

    // Refresh / second tab resuming the same identity restores exact limb & gesture and kicks old socket
    const seatA = rA.data!;
    const resumed = session.resumePlayer('s4_new_tab', seatA.resumeToken);
    expect(resumed.ok).toBe(true);
    expect(resumed.data?.playerId).toBe(seatA.playerId);
    expect(resumed.data?.teamNumber).toBe(seatA.teamNumber);
    expect(resumed.data?.limbIndex).toBe(seatA.limbIndex);
    expect(resumed.data?.assignment.gestureId).toBe(seatA.assignment.gestureId);
    expect(resumed.data?.connectionGeneration).toBe(seatA.connectionGeneration + 1);
    expect(supersededSockets).toEqual(['s4_contender_A']);

    // Old socket can no longer submit strokes
    expect(
      session.updateSensorStatus('s4_contender_A', { sensorStatus: 'ready' }).code,
    ).toBe('NOT_SEATED');
  });

  it('deduplicates retried strokes, enforces 1 stroke per attemptId, and rejects pre-pause strokes after resume via inputEpoch', () => {
    let nowMs = 5000;
    const session = new ClassroomGameSession({ nowFn: () => nowMs });
    const seat = joinAndCalibrate(session, 'p1', 1);

    // Stage & start straight race (with readiness override since only 1 player joined)
    session.executeHostCommand({ commandId: 'c1', type: 'load_phase', phase: 'straight' });
    session.executeHostCommand({
      commandId: 'c2',
      type: 'start_phase',
      overrideWarnings: true,
    });

    // During 3s countdown, strokes MUST NOT award propulsion
    const countdownSnap = session.getPublicSnapshot();
    expect(countdownSnap.runStatus).toBe('countdown');
    const duringCountdown = session.handleStrokeComplete('p1', {
      strokeId: 'stk_cd',
      attemptId: 'att_cd',
      attemptSeq: 1,
      sessionId: countdownSnap.sessionId,
      roundId: countdownSnap.round.roundId,
      inputEpoch: countdownSnap.inputEpoch,
      connectionGeneration: seat.connectionGeneration,
      calibrationVersion: seat.calibrationVersion,
      gestureId: seat.assignment.gestureId,
      inputMethod: 'physical_sweep',
      durationMs: 320,
      clientCompletedAtMs: nowMs,
    });
    expect(duringCountdown.ok).toBe(false);
    expect(duringCountdown.code).toBe('ROUND_NOT_RUNNING');

    // Complete 3000ms countdown -> running
    nowMs += 3000;
    session.stepSimulation(3000);
    const runningSnap = session.getPublicSnapshot();
    expect(runningSnap.runStatus).toBe('running');

    // Accept first valid stroke
    const firstAck = session.handleStrokeComplete('p1', {
      strokeId: 'stk_1',
      attemptId: 'att_1',
      attemptSeq: 2,
      sessionId: runningSnap.sessionId,
      roundId: runningSnap.round.roundId,
      inputEpoch: runningSnap.inputEpoch,
      connectionGeneration: seat.connectionGeneration,
      calibrationVersion: seat.calibrationVersion,
      gestureId: seat.assignment.gestureId,
      inputMethod: 'physical_sweep',
      durationMs: 350,
      clientCompletedAtMs: nowMs,
    });
    expect(firstAck.ok).toBe(true);
    const vxAfterOne = session.getPublicSnapshot().teams[0].sim.vx;
    expect(vxAfterOne).toBeGreaterThan(0);

    // Retry of the EXACT same strokeId returns ok without adding a second impulse!
    const retryAck = session.handleStrokeComplete('p1', {
      strokeId: 'stk_1',
      attemptId: 'att_1',
      attemptSeq: 2,
      sessionId: runningSnap.sessionId,
      roundId: runningSnap.round.roundId,
      inputEpoch: runningSnap.inputEpoch,
      connectionGeneration: seat.connectionGeneration,
      calibrationVersion: seat.calibrationVersion,
      gestureId: seat.assignment.gestureId,
      inputMethod: 'physical_sweep',
      durationMs: 350,
      clientCompletedAtMs: nowMs,
    });
    expect(retryAck.ok).toBe(true);
    expect(retryAck.code).toBe('DUPLICATE_ALREADY_ACCEPTED');
    expect(session.getPublicSnapshot().teams[0].sim.vx).toBe(vxAfterOne);

    // Different strokeId referencing the SAME button press attemptId is rejected!
    nowMs += 600;
    const secondOnSamePress = session.handleStrokeComplete('p1', {
      strokeId: 'stk_1_extra',
      attemptId: 'att_1',
      attemptSeq: 2,
      sessionId: runningSnap.sessionId,
      roundId: runningSnap.round.roundId,
      inputEpoch: runningSnap.inputEpoch,
      connectionGeneration: seat.connectionGeneration,
      calibrationVersion: seat.calibrationVersion,
      gestureId: seat.assignment.gestureId,
      inputMethod: 'physical_sweep',
      durationMs: 350,
      clientCompletedAtMs: nowMs,
    });
    expect(secondOnSamePress.ok).toBe(false);
    expect(secondOnSamePress.code).toBe('ALREADY_SCORED_THIS_PRESS');

    // Pause for 20 seconds -> active round time MUST NOT advance, and pre-pause inputEpoch is invalidated after resume!
    const prePauseEpoch = runningSnap.inputEpoch;
    const activeBeforePause = session.getPublicSnapshot().round.activeElapsedMs;
    session.executeHostCommand({ commandId: 'c3', type: 'pause_phase' });

    nowMs += 20000;
    session.stepSimulation(20000);
    expect(session.getPublicSnapshot().round.activeElapsedMs).toBe(activeBeforePause);

    session.executeHostCommand({ commandId: 'c4', type: 'resume_phase' });
    const resumedSnap = session.getPublicSnapshot();
    expect(resumedSnap.round.roundId).toBe(runningSnap.round.roundId);
    expect(resumedSnap.inputEpoch).toBeGreaterThan(prePauseEpoch);

    // Delayed pre-pause stroke arriving after resume (same roundId, old prePauseEpoch) MUST be rejected!
    const delayedPrePause = session.handleStrokeComplete('p1', {
      strokeId: 'stk_delayed_pre_pause',
      attemptId: 'att_pre_pause',
      attemptSeq: 3,
      sessionId: resumedSnap.sessionId,
      roundId: resumedSnap.round.roundId,
      inputEpoch: prePauseEpoch,
      connectionGeneration: seat.connectionGeneration,
      calibrationVersion: seat.calibrationVersion,
      gestureId: seat.assignment.gestureId,
      inputMethod: 'physical_sweep',
      durationMs: 340,
      clientCompletedAtMs: nowMs,
    });
    expect(delayedPrePause.ok).toBe(false);
    expect(delayedPrePause.code).toBe('STALE_INPUT_EPOCH');
  });

  it('normalizes dynamic 1- through 6-limb full cycles equally, cancels balanced bank turning, and never inflates power on disconnect', () => {
    let nowMs = 10000;
    const session = new ClassroomGameSession({
      nowFn: () => nowMs,
      initialMinTeamSize: 1,
      initialMaxTeamSize: 6,
    });

    // Join 1, 2, 3, 4, 5, and 6 players onto Teams 1..6 respectively!
    const teamSeats: Record<number, PlayerPrivateSeat[]> = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
    for (const teamNum of [1, 2, 3, 4, 5, 6]) {
      for (let i = 0; i < teamNum; i++) {
        teamSeats[teamNum].push(joinAndCalibrate(session, `t${teamNum}_p${i}`, teamNum));
      }
    }

    // 1. Test Free-Water forward impulse & balanced turning across all dynamic sizes 1..6
    session.executeHostCommand({
      commandId: 'fw_load',
      type: 'load_phase',
      phase: 'freewater',
      scoringEnabled: false,
    });
    session.executeHostCommand({ commandId: 'fw_start', type: 'start_phase' });
    const snap = session.getPublicSnapshot();

    for (const teamNum of [1, 2, 3, 4, 5, 6]) {
      for (const seat of teamSeats[teamNum]) {
        const ack = session.handleStrokeComplete(`t${teamNum}_p${seat.limbIndex}`, {
          strokeId: `fw_stk_${teamNum}_${seat.limbIndex}`,
          attemptId: `fw_att_${teamNum}_${seat.limbIndex}`,
          attemptSeq: 1,
          sessionId: snap.sessionId,
          roundId: snap.round.roundId,
          inputEpoch: snap.inputEpoch,
          connectionGeneration: seat.connectionGeneration,
          calibrationVersion: seat.calibrationVersion,
          gestureId: seat.assignment.gestureId,
          inputMethod: 'physical_sweep',
          durationMs: 300,
          clientCompletedAtMs: nowMs,
        });
        expect(ack.ok).toBe(true);
      }
    }

    const afterCycle = session.getPublicSnapshot();
    const speeds = afterCycle.teams.map((t) => Math.hypot(t.sim.vx, t.sim.vy));
    for (let i = 1; i < speeds.length; i++) {
      expect(speeds[i]).toBeCloseTo(speeds[0], 5);
    }

    // Balanced left + right (+ center_rear on odd 1, 3, 5-limb teams) cancels turning cleanly to 0!
    for (const t of afterCycle.teams) {
      expect(t.sim.angularVel).toBeCloseTo(0, 6);
    }

    // 2. Disconnect 1 player from Team 5 (5 joined limbs) and verify remaining player's stroke impulse does NOT increase
    session.executeHostCommand({ commandId: 'sr_load', type: 'load_phase', phase: 'straight' });
    session.executeHostCommand({ commandId: 'sr_start', type: 'start_phase' });
    nowMs += 3000;
    session.stepSimulation(3000);

    session.handleSocketDisconnect('t5_p4');
    const raceSnap = session.getPublicSnapshot();
    expect(raceSnap.teams[4].limbCount).toBe(5);
    expect(raceSnap.teams[4].connectedCount).toBe(4);

    const remainingSeat = teamSeats[5][0];
    session.handleStrokeComplete('t5_p0', {
      strokeId: 'disc_check_stk',
      attemptId: 'disc_check_att',
      attemptSeq: 2,
      sessionId: raceSnap.sessionId,
      roundId: raceSnap.round.roundId,
      inputEpoch: raceSnap.inputEpoch,
      connectionGeneration: remainingSeat.connectionGeneration,
      calibrationVersion: remainingSeat.calibrationVersion,
      gestureId: remainingSeat.assignment.gestureId,
      inputMethod: 'physical_sweep',
      durationMs: 300,
      clientCompletedAtMs: nowMs,
    });

    // A lone straight-swim stroke is priced on the 5 joined limbs (N stays 5, never 4) at the
    // out-of-sync multiplier; losing a teammate must not raise it.
    expect(session.getPublicSnapshot().teams[4].sim.vx).toBeCloseTo(
      (GAME_DEFAULTS.baseCycleForwardImpulse / 5) * GAME_DEFAULTS.syncMinMultiplier,
      5,
    );
  });

  it('preserves exact scoring equivalence between continuous and stroke_events network modes', () => {
    const runSingleStrokeInMode = (mode: 'continuous' | 'stroke_events'): number => {
      let nowMs = 1000;
      const s = new ClassroomGameSession({
        nowFn: () => nowMs,
        initialMinTeamSize: 1,
        initialMaxTeamSize: 6,
      });
      const seat = joinAndCalibrate(s, 'p0', 1);
      s.executeHostCommand({ commandId: 'm', type: 'set_network_mode', networkMode: mode });
      s.executeHostCommand({ commandId: 'l', type: 'load_phase', phase: 'straight' });
      s.executeHostCommand({ commandId: 'st', type: 'start_phase', overrideWarnings: true });
      nowMs += 3000;
      s.stepSimulation(3000);
      const snap = s.getPublicSnapshot();

      // Send 10 intermediate previews in continuous mode (and attempt in stroke_events mode)
      for (let i = 1; i <= 10; i++) {
        s.handleInputPreview('p0', {
          attemptId: 'a1',
          attemptSeq: 1,
          sessionId: snap.sessionId,
          roundId: snap.round.roundId,
          inputEpoch: snap.inputEpoch,
          connectionGeneration: seat.connectionGeneration,
          progress: i / 10,
        });
      }

      s.handleStrokeComplete('p0', {
        strokeId: 's1',
        attemptId: 'a1',
        attemptSeq: 1,
        sessionId: snap.sessionId,
        roundId: snap.round.roundId,
        inputEpoch: snap.inputEpoch,
        connectionGeneration: seat.connectionGeneration,
        calibrationVersion: seat.calibrationVersion,
        gestureId: seat.assignment.gestureId,
        inputMethod: 'physical_sweep',
        durationMs: 320,
        clientCompletedAtMs: nowMs,
      });

      for (let tick = 0; tick < 60; tick++) {
        nowMs += 16;
        s.stepSimulation(16);
      }
      return s.getPublicSnapshot().teams[0].sim.laneProgress;
    };

    const distContinuous = runSingleStrokeInMode('continuous');
    const distEvents = runSingleStrokeInMode('stroke_events');
    expect(distContinuous).toBeGreaterThan(0);
    expect(distContinuous).toBeCloseTo(distEvents, 8);
  });

  it('awards simultaneous item contact exactly once using nearest-center then team-ID tie-break', () => {
    let nowMs = 1000;
    const session = new ClassroomGameSession({
      nowFn: () => nowMs,
      initialMinTeamSize: 1,
      initialMaxTeamSize: 6,
    });
    joinAndCalibrate(session, 't1', 1);
    joinAndCalibrate(session, 't2', 2);

    session.executeHostCommand({
      commandId: 'fw1',
      type: 'load_phase',
      phase: 'freewater',
      scoringEnabled: true,
      seed: 42,
    });
    session.executeHostCommand({
      commandId: 'fw2',
      type: 'start_phase',
      overrideWarnings: true,
    });
    nowMs += 3000;
    session.stepSimulation(3000);

    // Place both Team 1 and Team 2 right onto item[0]'s exact coordinates via internal snapshot access in test
    const internalTeams = (session as unknown as { teams: Map<number, { sim: { x: number; y: number } }> }).teams;
    const firstItem = session.getPublicSnapshot().round.items[0];
    internalTeams.get(1)!.sim.x = firstItem.x;
    internalTeams.get(1)!.sim.y = firstItem.y;
    internalTeams.get(2)!.sim.x = firstItem.x;
    internalTeams.get(2)!.sim.y = firstItem.y;

    nowMs += 16;
    session.stepSimulation(16);

    const after = session.getPublicSnapshot();
    const updatedItem = after.round.items.find((i) => i.itemId === firstItem.itemId)!;
    expect(updatedItem.available).toBe(false);
    expect(updatedItem.collectedByTeam).toBe(1); // Exact distance tie broken deterministically by teamNumber 1 < 2
    // The item's own point value is awarded exactly once, to one team
    expect(firstItem.points).toBe(POND_ITEMS[firstItem.variant].points);
    expect(after.teams[0].sim.score).toBe(firstItem.points);
    expect(after.teams[0].sim.itemsCollected).toBe(1);
    expect(after.teams[1].sim.score).toBe(0);
    expect(after.teams[1].sim.itemsCollected).toBe(0);
  });

  it('ranks finished teams by finish time, unfinished teams by distance on timeout, and preserves scoped resets', () => {
    let nowMs = 1000;
    const session = new ClassroomGameSession({
      nowFn: () => nowMs,
      initialMinTeamSize: 1,
      initialMaxTeamSize: 6,
    });
    const p1 = joinAndCalibrate(session, 's1', 1);
    const p2 = joinAndCalibrate(session, 's2', 2);
    joinAndCalibrate(session, 's3', 3);

    // Practice in training first, then verify scoped practice reset preserves calibration & seats
    session.executeHostCommand({ commandId: 'tr1', type: 'load_phase', phase: 'training' });
    session.executeHostCommand({ commandId: 'tr2', type: 'start_phase' });
    const trSnap = session.getPublicSnapshot();
    session.handleStrokeComplete('s1', {
      strokeId: 'prac_1',
      attemptId: 'patt_1',
      attemptSeq: 1,
      sessionId: trSnap.sessionId,
      roundId: trSnap.round.roundId,
      inputEpoch: trSnap.inputEpoch,
      connectionGeneration: p1.connectionGeneration,
      calibrationVersion: p1.calibrationVersion,
      gestureId: p1.assignment.gestureId,
      inputMethod: 'physical_sweep',
      durationMs: 300,
      clientCompletedAtMs: nowMs,
    });
    expect(session.getPublicSnapshot().teams[0].practicedCount).toBe(1);

    // Reset practice for Team 1: clears practice count, preserves calibratedCount and seat!
    session.executeHostCommand({ commandId: 'rp1', type: 'reset_practice_team', teamNumber: 1 });
    const afterPracticeReset = session.getPublicSnapshot().teams[0];
    expect(afterPracticeReset.practicedCount).toBe(0);
    expect(afterPracticeReset.calibratedCount).toBe(1);
    expect(afterPracticeReset.joinedCount).toBe(1);

    // Recalibrate single player: invalidates only that player's calibration while preserving limb & gesture
    session.executeHostCommand({ commandId: 'rc1', type: 'recalibrate_player', playerId: p1.playerId });
    expect(session.getPublicSnapshot().teams[0].calibratedCount).toBe(0);
    const recalRes = session.completeCalibration('s1', {
      assignmentVersion: p1.assignment.assignmentVersion,
      calibration: makeValidCal(2),
      inputMethod: 'physical_sweep',
    });
    expect(recalRes.ok).toBe(true);
    const p1NewCalVer = recalRes.data!.calibrationVersion;

    // Straight race ranking when the facilitator ends it: Team 1 finishes, Teams 2 and 3 do not
    const p1b = joinAndCalibrate(session, 's1_b', 1);
    const p1c = joinAndCalibrate(session, 's1_c', 1);
    const p1d = joinAndCalibrate(session, 's1_d', 1);

    session.executeHostCommand({
      commandId: 'sr1',
      type: 'load_phase',
      phase: 'straight',
    });
    session.executeHostCommand({
      commandId: 'sr2',
      type: 'start_phase',
      overrideWarnings: true,
    });
    nowMs += 3000;
    session.stepSimulation(3000);

    // Drive full 4-player Team 1 across the finish line (~55s), give Team 2 partial progress, Team 3 zero progress
    for (let k = 0; k < 1000; k++) {
      const cur = session.getPublicSnapshot();
      if (!cur.teams[0].sim.finished && k % 10 === 0) {
        for (const [sockId, seatObj, calVer] of [
          ['s1', p1, p1NewCalVer],
          ['s1_b', p1b, p1b.calibrationVersion],
          ['s1_c', p1c, p1c.calibrationVersion],
          ['s1_d', p1d, p1d.calibrationVersion],
        ] as const) {
          session.handleStrokeComplete(sockId, {
            strokeId: `win_${sockId}_${k}`,
            attemptId: `watt_${sockId}_${k}`,
            attemptSeq: 10 + k,
            sessionId: cur.sessionId,
            roundId: cur.round.roundId,
            inputEpoch: cur.inputEpoch,
            connectionGeneration: seatObj.connectionGeneration,
            calibrationVersion: calVer,
            gestureId: seatObj.assignment.gestureId,
            inputMethod: 'physical_sweep',
            durationMs: 280,
            clientCompletedAtMs: nowMs,
          });
        }
      }
      if (k === 10) {
        session.handleStrokeComplete('s2', {
          strokeId: 'partial_2',
          attemptId: 'p2_att',
          attemptSeq: 2,
          sessionId: cur.sessionId,
          roundId: cur.round.roundId,
          inputEpoch: cur.inputEpoch,
          connectionGeneration: p2.connectionGeneration,
          calibrationVersion: p2.calibrationVersion,
          gestureId: p2.assignment.gestureId,
          inputMethod: 'physical_sweep',
          durationMs: 280,
          clientCompletedAtMs: nowMs,
        });
      }
      nowMs += 100;
      session.stepSimulation(100);
    }

    // 100 s in, with two creatures still out: nothing ends the race but the facilitator
    expect(session.getPublicSnapshot().runStatus).toBe('running');
    expect(session.executeHostCommand({ commandId: 'sr_end', type: 'end_round' }).ok).toBe(true);

    const fin = session.getPublicSnapshot();
    expect(fin.runStatus).toBe('finished');
    expect(fin.leaderboard.straight?.endedBy).toBe('facilitator');
    expect(fin.teams[0].sim.finished).toBe(true);
    expect(fin.teams[0].sim.rank).toBe(1);
    expect(fin.teams[1].sim.finished).toBe(false);
    expect(fin.teams[1].sim.rank).toBe(2);
    expect(fin.teams[2].sim.finished).toBe(false);
    expect(fin.teams[2].sim.rank).toBe(3);
    expect(fin.teams).toHaveLength(3);
  });
});

describe('Random gesture assignment', () => {
  it('gives teammates different gestures and does not tie a gesture to team number or join order', () => {
    const firstGestureOfTeamOne = new Set<string>();
    for (let run = 0; run < 40; run++) {
      const session = new ClassroomGameSession();
      session.executeHostCommand({
        commandId: `sz_${run}`,
        type: 'set_team_size_bounds',
        minTeamSize: 3,
        maxTeamSize: 6,
      });
      const gestures: string[] = [];
      for (let i = 0; i < 6; i++) {
        gestures.push(joinAndCalibrate(session, `rg_${run}_${i}`, 1).assignment.gestureId);
      }
      // Six limbs, six gestures in the vocabulary: every teammate has a different sweep
      expect(new Set(gestures).size).toBe(6);
      firstGestureOfTeamOne.add(gestures[0]);
    }
    // The old rule gave Team 1's first player the same gesture every time. A fixed result over
    // 40 independent sessions now has probability 6^-39.
    expect(firstGestureOfTeamOne.size).toBeGreaterThan(1);
  });
});

describe('Session flow v0.2 — sync propulsion, race ending, prep, discussion, and leaderboard phases', () => {
  const BASE = GAME_DEFAULTS.baseCycleForwardImpulse;

  /** One team of `size` calibrated players in a running scored straight race; time is driven by the returned clock. */
  function startRaceWithTeam(size: number, mode: 'continuous' | 'stroke_events' = 'continuous') {
    const clock = { nowMs: 1000 };
    const session = new ClassroomGameSession({
      nowFn: () => clock.nowMs,
      initialMinTeamSize: 1,
      initialMaxTeamSize: 6,
    });
    const seats = Array.from({ length: size }, (_, i) => joinAndCalibrate(session, `p${i}`, 1));
    session.executeHostCommand({ commandId: 'mode', type: 'set_network_mode', networkMode: mode });
    session.executeHostCommand({ commandId: 'load', type: 'load_phase', phase: 'straight' });
    session.executeHostCommand({ commandId: 'start', type: 'start_phase', overrideWarnings: true });
    clock.nowMs += 3000;
    session.stepSimulation(3000);
    expect(session.getPublicSnapshot().runStatus).toBe('running');
    const vx = () => session.getPublicSnapshot().teams[0].sim.vx;
    return { session, seats, clock, vx };
  }

  it('Game 1: the more limbs stroke together the faster, and unsynchronized strokes are penalized', () => {
    // No simulation steps between strokes, so vx is exactly the propulsion granted so far.
    const speedWithLimbsTogether = (together: number): number => {
      const { session, seats, clock, vx } = startRaceWithTeam(4);
      for (let i = 0; i < together; i++) {
        clock.nowMs += 40; // well inside the sync window
        expect(stroke(session, `p${i}`, seats[i], `sync_${i}`).ok).toBe(true);
      }
      return vx();
    };

    const [one, two, three, four] = [1, 2, 3, 4].map(speedWithLimbsTogether);
    expect(one).toBeCloseTo((BASE / 4) * GAME_DEFAULTS.syncMinMultiplier, 6);
    expect(two).toBeCloseTo(2 * (BASE / 4) * getSyncMultiplier(2, 4), 6);
    expect(three).toBeCloseTo(3 * (BASE / 4) * getSyncMultiplier(3, 4), 6);
    expect(four).toBeCloseTo(BASE * GAME_DEFAULTS.syncMaxMultiplier, 6);
    expect(one).toBeLessThan(two);
    expect(two).toBeLessThan(three);
    expect(three).toBeLessThan(four);

    // The same four strokes spread outside the window earn only the out-of-sync rate each
    const { session, seats, clock, vx } = startRaceWithTeam(4);
    for (let i = 0; i < 4; i++) {
      clock.nowMs += GAME_DEFAULTS.syncWindowMs + 50;
      expect(stroke(session, `p${i}`, seats[i], `apart_${i}`).ok).toBe(true);
    }
    expect(vx()).toBeCloseTo(BASE * GAME_DEFAULTS.syncMinMultiplier, 6);
    expect(vx()).toBeLessThan(four / 4);
    expect(session.getPublicSnapshot().teams[0].sim.syncCount).toBe(1);
  });

  it('Game 1: a fully synchronized cycle is worth the same for every team size and in both network modes', () => {
    const fullSyncSpeed = (size: number, mode: 'continuous' | 'stroke_events'): number => {
      const { session, seats, clock, vx } = startRaceWithTeam(size, mode);
      // Reverse arrival order: the group total must not depend on who lands first
      for (let i = size - 1; i >= 0; i--) {
        clock.nowMs += 30;
        stroke(session, `p${i}`, seats[i], `full_${i}`);
      }
      expect(session.getPublicSnapshot().teams[0].sim.syncCount).toBe(size);
      return vx();
    };

    for (const size of [1, 2, 3, 4, 5, 6]) {
      expect(fullSyncSpeed(size, 'continuous')).toBeCloseTo(BASE * GAME_DEFAULTS.syncMaxMultiplier, 6);
      expect(fullSyncSpeed(size, 'stroke_events')).toBeCloseTo(fullSyncSpeed(size, 'continuous'), 9);
    }
  });

  it('Game 1: a disconnected teammate lowers the reachable sync and never adds power', () => {
    const { session, seats, clock, vx } = startRaceWithTeam(4);
    session.handleSocketDisconnect('p3');
    expect(session.getPublicSnapshot().teams[0].limbCount).toBe(4);

    for (let i = 0; i < 3; i++) {
      clock.nowMs += 30;
      stroke(session, `p${i}`, seats[i], `three_${i}`);
    }
    // Three of four joined limbs: priced as 3-of-4, strictly below the full-team cycle
    expect(vx()).toBeCloseTo(3 * (BASE / 4) * getSyncMultiplier(3, 4), 6);
    expect(vx()).toBeLessThan(BASE * GAME_DEFAULTS.syncMaxMultiplier);
  });

  it('Game 1 keeps running after the first finisher and ends only when the last creature is home', () => {
    const clock = { nowMs: 1000 };
    const session = new ClassroomGameSession({
      nowFn: () => clock.nowMs,
      initialMinTeamSize: 1,
      initialMaxTeamSize: 6,
    });
    const a = joinAndCalibrate(session, 'a', 1);
    const b = joinAndCalibrate(session, 'b', 2);
    session.executeHostCommand({ commandId: 'l', type: 'load_phase', phase: 'straight' });
    session.executeHostCommand({ commandId: 's', type: 'start_phase', overrideWarnings: true });
    clock.nowMs += 3000;
    session.stepSimulation(3000);

    const swim = (sockId: string, seat: PlayerPrivateSeat, teamIdx: number, tag: string) => {
      for (let k = 0; k < 400 && !session.getPublicSnapshot().teams[teamIdx].sim.finished; k++) {
        stroke(session, sockId, seat, `${tag}_${k}`);
        for (let t = 0; t < 5; t++) {
          clock.nowMs += 100;
          session.stepSimulation(100);
        }
      }
    };

    swim('a', a, 0, 'a');
    const afterFirst = session.getPublicSnapshot();
    expect(afterFirst.teams[0].sim.finished).toBe(true);
    expect(afterFirst.teams[0].sim.rank).toBe(1);
    // First creature home: the race is still on for everyone else
    expect(afterFirst.runStatus).toBe('running');
    expect(afterFirst.leaderboard.straight).toBeNull();

    swim('b', b, 1, 'b');
    const afterLast = session.getPublicSnapshot();
    expect(afterLast.teams[1].sim.finished).toBe(true);
    expect(afterLast.teams[1].sim.rank).toBe(2);
    expect(afterLast.runStatus).toBe('finished');
    expect(afterLast.leaderboard.straight?.endedBy).toBe('all_finished');
  });

  it('Game 1 ends when its section clock reaches zero, with unfinished creatures ranked by distance', () => {
    const clock = { nowMs: 1000 };
    const session = new ClassroomGameSession({
      nowFn: () => clock.nowMs,
      initialMinTeamSize: 1,
      initialMaxTeamSize: 6,
    });
    joinAndCalibrate(session, 'a', 1);
    session.executeHostCommand({ commandId: 'l', type: 'load_phase', phase: 'straight' });
    session.executeHostCommand({ commandId: 's', type: 'start_phase', overrideWarnings: true });
    clock.nowMs += 3000;
    session.stepSimulation(3000);

    // The clock started at load, so the 3 s countdown came out of the planned time
    const plannedMs = SECTION_BUDGET_DEFAULTS_SEC.game1 * 1000;
    for (let t = 3000; t < plannedMs - 1000; t += 1000) {
      clock.nowMs += 1000;
      session.stepSimulation(1000);
    }
    expect(session.getPublicSnapshot().runStatus).toBe('running');
    expect(session.getPublicSnapshot().sectionClock.remainingMs).toBe(1000);

    clock.nowMs += 1000;
    session.stepSimulation(1000);
    const done = session.getPublicSnapshot();
    expect(done.runStatus).toBe('finished');
    expect(done.teams[0].sim.finished).toBe(false);
    expect(done.leaderboard.straight?.endedBy).toBe('time_up');
  });

  it('Game 1 Prep is an unscored lane practice: no countdown, no admission lock, laps instead of a finish, no result', () => {
    const clock = { nowMs: 1000 };
    const session = new ClassroomGameSession({
      nowFn: () => clock.nowMs,
      initialMinTeamSize: 1,
      initialMaxTeamSize: 6,
    });
    const seat = joinAndCalibrate(session, 'a', 1);
    session.executeHostCommand({
      commandId: 'l',
      type: 'load_phase',
      phase: 'straight',
      scoringEnabled: false,
    });
    const staged = session.getPublicSnapshot();
    expect(staged.round.scoringEnabled).toBe(false);
    expect(staged.sectionClock.section).toBe('game1_prep');
    expect(staged.sectionClock.budgetSec).toBe(SECTION_BUDGET_DEFAULTS_SEC.game1_prep);

    expect(session.executeHostCommand({ commandId: 's', type: 'start_phase' }).ok).toBe(true);
    expect(session.getPublicSnapshot().runStatus).toBe('running');
    expect(session.getPublicSnapshot().admissionLocked).toBe(false);

    let lapped = false;
    let lastProgress = 0;
    for (let k = 0; k < 235; k++) {
      stroke(session, 'a', seat, `lap_${k}`);
      for (let t = 0; t < 5; t++) {
        clock.nowMs += 100;
        session.stepSimulation(100);
      }
      const sim = session.getPublicSnapshot().teams[0].sim;
      if (sim.laneProgress < lastProgress) lapped = true;
      lastProgress = sim.laneProgress;
      expect(sim.finished).toBe(false);
    }
    expect(lapped).toBe(true);

    // Well past the planned time the practice is still going; it stops when the facilitator says so
    clock.nowMs += 120000;
    session.stepSimulation(120000);
    expect(session.getPublicSnapshot().runStatus).toBe('running');
    expect(session.getPublicSnapshot().sectionClock.remainingMs).toBeLessThan(0);
    expect(session.executeHostCommand({ commandId: 'e', type: 'end_round' }).ok).toBe(true);
    const done = session.getPublicSnapshot();
    expect(done.runStatus).toBe('finished');
    expect(done.teams[0].sim.rank).toBeNull();
    expect(done.leaderboard.straight).toBeNull();
    expect(done.leaderboard.standings).toHaveLength(0);
  });

  it('discussion is its own display-only phase with a topic; nothing can be started, ended, or paddled', () => {
    const session = new ClassroomGameSession({ initialMinTeamSize: 1, initialMaxTeamSize: 6 });
    const seat = joinAndCalibrate(session, 'a', 1);

    const noTopic = session.executeHostCommand({ commandId: 'd0', type: 'load_phase', phase: 'discussion' });
    expect(noTopic.code).toBe('INVALID_DISCUSSION_TOPIC');
    const bogusPhase = {
      commandId: 'd_bogus',
      type: 'load_phase',
      phase: 'results_please',
    } as unknown as HostCommandPayload;
    expect(session.executeHostCommand(bogusPhase).code).toBe('INVALID_PHASE');

    for (const topic of ['before_game1', 'after_game1'] as const) {
      expect(
        session.executeHostCommand({
          commandId: `d_${topic}`,
          type: 'load_phase',
          phase: 'discussion',
          discussionTopic: topic,
        }).ok,
      ).toBe(true);
      const snap = session.getPublicSnapshot();
      expect(snap.phase).toBe('discussion');
      expect(snap.round.discussionTopic).toBe(topic);
      expect(snap.round.scoringEnabled).toBe(false);

      expect(session.executeHostCommand({ commandId: `s_${topic}`, type: 'start_phase' }).code).toBe(
        'NOTHING_TO_START',
      );
      expect(session.executeHostCommand({ commandId: `e_${topic}`, type: 'end_round' }).code).toBe(
        'NO_ROUND_TO_END',
      );
      expect(session.executeHostCommand({ commandId: `p_${topic}`, type: 'pause_phase' }).code).toBe(
        'NOT_RUNNING',
      );
      expect(stroke(session, 'a', seat, `talk_${topic}`).code).toBe('ROUND_NOT_RUNNING');
    }

    // Leaving the discussion clears its topic
    session.executeHostCommand({ commandId: 'tr', type: 'load_phase', phase: 'training' });
    expect(session.getPublicSnapshot().round.discussionTopic).toBeNull();
  });

  it('leaderboard keeps each completed game, scores placements transparently, shares tied ranks, and clears with the session', () => {
    const clock = { nowMs: 1000 };
    const session = new ClassroomGameSession({
      nowFn: () => clock.nowMs,
      initialMinTeamSize: 1,
      initialMaxTeamSize: 6,
    });
    const a = joinAndCalibrate(session, 'a', 1);
    joinAndCalibrate(session, 'b', 2);
    const advance = (ms: number) => {
      clock.nowMs += ms;
      session.stepSimulation(ms);
    };

    // Game 1: Team 1 swims home, Team 2 never moves; the facilitator ends the round
    session.executeHostCommand({ commandId: 'g1l', type: 'load_phase', phase: 'straight' });
    session.executeHostCommand({ commandId: 'g1s', type: 'start_phase', overrideWarnings: true });
    advance(3000);
    for (let k = 0; k < 400 && !session.getPublicSnapshot().teams[0].sim.finished; k++) {
      stroke(session, 'a', a, `g1_${k}`);
      for (let t = 0; t < 5; t++) advance(100);
    }
    expect(session.getPublicSnapshot().runStatus).toBe('running');
    session.executeHostCommand({ commandId: 'g1e', type: 'end_round' });

    const afterGame1 = session.getPublicSnapshot().leaderboard;
    expect(afterGame1.straight?.endedBy).toBe('facilitator');
    expect(afterGame1.straight?.teams.map((t) => [t.teamNumber, t.rank, t.finished])).toEqual([
      [1, 1, true],
      [2, 2, false],
    ]);
    const team1Race = afterGame1.straight!.teams[0];
    expect(team1Race.strokes).toBeGreaterThan(0);
    expect(team1Race.syncAvg).toBeCloseTo(1, 6); // a one-limb creature is always fully in sync
    expect(afterGame1.standings).toEqual([
      { teamNumber: 1, rank: 1, points: 2 },
      { teamNumber: 2, rank: 2, points: 1 },
    ]);

    // The dedicated discussion between the games does not disturb the stored result
    session.executeHostCommand({
      commandId: 'talk',
      type: 'load_phase',
      phase: 'discussion',
      discussionTopic: 'after_game1',
    });
    expect(session.getPublicSnapshot().leaderboard.straight?.teams).toHaveLength(2);

    // Game 2: Team 2 collects one item, Team 1 none
    session.executeHostCommand({
      commandId: 'g2l',
      type: 'load_phase',
      phase: 'freewater',
      scoringEnabled: true,
      seed: 7,
    });
    session.executeHostCommand({ commandId: 'g2s', type: 'start_phase', overrideWarnings: true });
    advance(3000);
    const internalTeams = (session as unknown as { teams: Map<number, { sim: { x: number; y: number } }> }).teams;
    const item = session.getPublicSnapshot().round.items[0];
    internalTeams.get(2)!.sim.x = item.x;
    internalTeams.get(2)!.sim.y = item.y;
    advance(16);
    session.executeHostCommand({ commandId: 'g2e', type: 'end_round' });

    session.executeHostCommand({ commandId: 'lb', type: 'load_phase', phase: 'leaderboard' });
    const board = session.getPublicSnapshot();
    expect(board.phase).toBe('leaderboard');
    expect(
      board.leaderboard.freewater?.teams.map((t) => [t.teamNumber, t.rank, t.score, t.items]),
    ).toEqual([
      [1, 2, 0, 0],
      [2, 1, item.points, 1],
    ]);
    // 2 + 1 points each: equal totals share rank 1, with no hidden tie-break
    expect(board.leaderboard.standings).toEqual([
      { teamNumber: 1, rank: 1, points: 3 },
      { teamNumber: 2, rank: 1, points: 3 },
    ]);
    expect(session.executeHostCommand({ commandId: 'lbs', type: 'start_phase' }).code).toBe(
      'NOTHING_TO_START',
    );

    session.executeHostCommand({ commandId: 'clr', type: 'clear_session', confirmClearSession: true });
    const cleared = session.getPublicSnapshot();
    expect(cleared.leaderboard).toEqual({ straight: null, freewater: null, standings: [] });
    expect(cleared.guideVisible).toBe(true);
  });
});

describe('Revision 0.4 — dynamic limbs, item kinds, Game 2 Prep items, and the music switch', () => {
  function makeSession() {
    const clock = { nowMs: 1000 };
    const session = new ClassroomGameSession({
      nowFn: () => clock.nowMs,
      initialMinTeamSize: 1,
      initialMaxTeamSize: 6,
    });
    const advance = (ms: number) => {
      // Fixed 60 Hz steps, like the server loop
      let left = ms;
      while (left > 0) {
        const dt = Math.min(1000 / 60, left);
        clock.nowMs += dt;
        session.stepSimulation(dt);
        left -= dt;
      }
    };
    return { session, clock, advance };
  }
  const GRACE = GAME_DEFAULTS.disconnectedLimbGraceMs;
  const names = (session: ClassroomGameSession, teamNumber = 1) =>
    session
      .getPublicSnapshot()
      .teams.find((t) => t.teamNumber === teamNumber)
      ?.limbs.map((l) => l.playerName) ?? [];
  const join = (session: ClassroomGameSession, socketId: string, name: string, teamNumber = 1) => {
    const res = session.joinPlayer(socketId, teamNumber, name);
    if (!res.ok || !res.data) throw new Error(`Join failed: ${res.code}`);
    return res.data;
  };

  it('keeps a disconnected limb through the grace period, then removes it and renumbers the rest', () => {
    const { session, advance } = makeSession();
    const seats = ['Ana', 'Ben', 'Cy', 'Di'].map((n, i) => join(session, `s${i}`, n));

    session.handleSocketDisconnect('s1'); // Ben
    advance(GRACE - 200);
    let team = session.getPublicSnapshot().teams[0];
    expect(team.limbCount).toBe(4);
    expect(team.limbs[1].playerName).toBe('Ben');
    expect(team.limbs[1].connected).toBe(false);

    advance(400);
    team = session.getPublicSnapshot().teams[0];
    expect(team.limbCount).toBe(3);
    expect(team.joinedCount).toBe(3);
    expect(team.limbs.map((l) => [l.limbIndex, l.playerName])).toEqual([
      [0, 'Ana'],
      [1, 'Cy'],
      [2, 'Di'],
    ]);
    // Nobody's gesture changed when the limbs were renumbered
    expect(team.limbs.map((l) => l.gestureId)).toEqual([
      seats[0].assignment.gestureId,
      seats[2].assignment.gestureId,
      seats[3].assignment.gestureId,
    ]);
    // Mission Control still lists Ben, marked as away
    const ben = session.getHostSnapshot().players.find((p) => p.playerName === 'Ben')!;
    expect(ben.seated).toBe(false);
    expect(ben.connected).toBe(false);
  });

  it('grows the limb back in its old place, with the same identity and gesture, when that phone returns', () => {
    const { session, advance } = makeSession();
    const seats = ['Ana', 'Ben', 'Cy', 'Di'].map((n, i) => join(session, `s${i}`, n));
    session.handleSocketDisconnect('s1');
    advance(GRACE + 100);
    expect(names(session)).toEqual(['Ana', 'Cy', 'Di']);

    const back = session.resumePlayer('s1_new', seats[1].resumeToken);
    expect(back.ok).toBe(true);
    expect(back.data?.playerId).toBe(seats[1].playerId);
    expect(back.data?.assignment.gestureId).toBe(seats[1].assignment.gestureId);
    expect(back.data?.limbIndex).toBe(1);
    expect(names(session)).toEqual(['Ana', 'Ben', 'Cy', 'Di']);
  });

  it('a quick refresh inside the grace period never changes the creature', () => {
    const { session, advance } = makeSession();
    const seats = ['Ana', 'Ben', 'Cy'].map((n, i) => join(session, `s${i}`, n));
    session.handleSocketDisconnect('s2');
    advance(1500);
    expect(session.resumePlayer('s2_new', seats[2].resumeToken).ok).toBe(true);
    advance(GRACE * 2);
    expect(names(session)).toEqual(['Ana', 'Ben', 'Cy']);
  });

  it('lets a person who lost their seat rejoin a full team as a new limb, without a ghost limb left behind', () => {
    const { session, advance } = makeSession();
    const seats = ['A', 'B', 'C', 'D', 'E', 'F'].map((n, i) => join(session, `s${i}`, n));
    expect(session.joinPlayer('extra', 1, 'G').code).toBe('TEAM_FULL');

    session.handleSocketDisconnect('s3'); // D closes the tab and loses the page
    advance(GRACE + 100);
    const rejoined = join(session, 's3_again', 'D again');
    const team = session.getPublicSnapshot().teams[0];
    expect(team.limbCount).toBe(6);
    expect(team.connectedCount).toBe(6);
    expect(team.limbs.map((l) => l.playerName)).toEqual(['A', 'B', 'C', 'E', 'F', 'D again']);
    // The newcomer takes the one sweep nobody seated is using, so all six still differ
    expect(new Set(team.limbs.map((l) => l.gestureId)).size).toBe(6);
    expect(rejoined.assignment.gestureId).toBe(seats[3].assignment.gestureId);

    // The old phone turning up now finds the team full and is sent back to the join screen
    const late = session.resumePlayer('s3_old', seats[3].resumeToken);
    expect(late.ok).toBe(false);
    expect(late.code).toBe('SEAT_NOT_FOUND');
    expect(session.getPublicSnapshot().teams[0].limbCount).toBe(6);
  });

  it('prices strokes for the limbs actually on the creature once a departed limb is released', () => {
    const { session, advance } = makeSession();
    const seats = [0, 1, 2, 3].map((i) => joinAndCalibrate(session, `p${i}`, 1));
    session.executeHostCommand({ commandId: 'l', type: 'load_phase', phase: 'straight', scoringEnabled: false });
    session.executeHostCommand({ commandId: 's', type: 'start_phase', overrideWarnings: true });
    advance(50);

    const speedAfterOneStroke = (id: string) => {
      const internal = (session as unknown as { teams: Map<number, { sim: { vx: number } }> }).teams.get(1)!;
      internal.sim.vx = 0;
      expect(stroke(session, 'p0', seats[0], id).ok).toBe(true);
      return internal.sim.vx;
    };
    const lone = GAME_DEFAULTS.syncMinMultiplier;
    const base = GAME_DEFAULTS.baseCycleForwardImpulse;

    session.handleSocketDisconnect('p3');
    // Inside the grace period the missing player is still one of four limbs: no extra power
    expect(speedAfterOneStroke('grace')).toBeCloseTo((base / 4) * lone, 6);

    advance(GRACE + 100);
    expect(session.getPublicSnapshot().teams[0].limbCount).toBe(3);
    // Afterwards the creature is a three-limb creature, exactly like a team that joined as three
    expect(speedAfterOneStroke('released')).toBeCloseTo((base / 3) * lone, 6);
  });

  it('counts only limbs on creatures toward the 30-player cap', () => {
    const { session, advance } = makeSession();
    for (let i = 0; i < 30; i++) join(session, `c${i}`, `P${i}`, Math.floor(i / 6) + 1);
    expect(session.joinPlayer('c30', 6, 'Late').code).toBe('SESSION_FULL');
    session.handleSocketDisconnect('c0');
    advance(GRACE + 100);
    expect(session.joinPlayer('c30', 6, 'Late').ok).toBe(true);
  });

  it('gives Game 2 Prep items worth points on the display but records no result', () => {
    const { session, advance } = makeSession();
    joinAndCalibrate(session, 'a', 1);
    joinAndCalibrate(session, 'b', 2);
    session.executeHostCommand({ commandId: 'l', type: 'load_phase', phase: 'freewater', scoringEnabled: false, seed: 5 });
    expect(session.getPublicSnapshot().round.items.length).toBe(GAME_DEFAULTS.targetActiveItems);
    session.executeHostCommand({ commandId: 's', type: 'start_phase' });
    advance(100);
    expect(session.getPublicSnapshot().runStatus).toBe('running');

    const internalTeams = (session as unknown as { teams: Map<number, { sim: { x: number; y: number } }> }).teams;
    const item = session.getPublicSnapshot().round.items[0];
    internalTeams.get(1)!.sim.x = item.x;
    internalTeams.get(1)!.sim.y = item.y;
    advance(16);
    expect(session.getPublicSnapshot().teams[0].sim.score).toBe(item.points);

    session.executeHostCommand({ commandId: 'e', type: 'end_round' });
    const after = session.getPublicSnapshot();
    expect(after.leaderboard.freewater).toBeNull();
    expect(after.leaderboard.standings).toEqual([]);
  });

  it('spawns three kinds of item with their own point values and at most one star at a time', () => {
    const { session, advance } = makeSession();
    joinAndCalibrate(session, 'a', 1);
    const seen = new Set<string>();
    for (let seed = 1; seed <= 60; seed++) {
      session.executeHostCommand({ commandId: `l${seed}`, type: 'load_phase', phase: 'freewater', scoringEnabled: true, seed });
      const items = session.getPublicSnapshot().round.items;
      for (const it of items) {
        seen.add(it.variant);
        expect(it.points).toBe(POND_ITEMS[it.variant].points);
      }
      expect(items.filter((it) => it.variant === 'pond_star').length).toBeLessThanOrEqual(1);
      expect(items.filter((it) => it.variant === 'golden_bug').length).toBeLessThanOrEqual(
        POND_ITEMS.golden_bug.maxActive,
      );
    }
    expect([...seen].sort()).toEqual(['glow_seed', 'golden_bug', 'pond_star']);
    expect(POND_ITEMS.glow_seed.points).toBeLessThan(POND_ITEMS.golden_bug.points);
    expect(POND_ITEMS.golden_bug.points).toBeLessThan(POND_ITEMS.pond_star.points);
    advance(1);
  });

  it('switches background music from Mission Control only, off by default, and keeps it across a session clear', () => {
    const { session } = makeSession();
    expect(session.getPublicSnapshot().musicEnabled).toBe(false);
    expect(session.executeHostCommand({ commandId: 'm1', type: 'set_music_enabled', enabled: true }).ok).toBe(true);
    expect(session.getPublicSnapshot().musicEnabled).toBe(true);
    expect(
      session.executeHostCommand({
        commandId: 'm2',
        type: 'set_music_enabled',
        enabled: 'yes' as unknown as boolean,
      }).ok,
    ).toBe(false);
    session.executeHostCommand({ commandId: 'clr', type: 'clear_session', confirmClearSession: true });
    expect(session.getPublicSnapshot().musicEnabled).toBe(true);
    expect(session.executeHostCommand({ commandId: 'm3', type: 'set_music_enabled', enabled: false }).ok).toBe(true);
    expect(session.getPublicSnapshot().musicEnabled).toBe(false);
  });
});

describe('Revision 0.5 — session plan and the section clock', () => {
  function makeSession() {
    const clock = { nowMs: 1000 };
    const session = new ClassroomGameSession({
      nowFn: () => clock.nowMs,
      initialMinTeamSize: 1,
      initialMaxTeamSize: 6,
    });
    const wait = (ms: number) => {
      clock.nowMs += ms;
      session.stepSimulation(ms);
    };
    return { session, clock, wait };
  }

  it("defaults to the owner's 25-minute plan", () => {
    expect(SECTION_BUDGET_DEFAULTS_SEC).toEqual({
      joining: 240,
      training: 120,
      game1_prep: 180,
      discussion_before_game1: 120,
      game1: 240,
      discussion_after_game1: 120,
      game2_prep: 180,
      game2: 300,
    });
    expect(SECTION_ORDER.reduce((sum, id) => sum + SECTION_BUDGET_DEFAULTS_SEC[id], 0)).toBe(25 * 60);
    expect(new ClassroomGameSession().getPublicSnapshot().sectionBudgetsSec).toEqual(SECTION_BUDGET_DEFAULTS_SEC);
  });

  it('maps every phase to its section, and gives the leaderboard none', () => {
    expect(sectionForPhase('lobby', false, null)).toBe('joining');
    expect(sectionForPhase('training', false, null)).toBe('training');
    expect(sectionForPhase('straight', false, null)).toBe('game1_prep');
    expect(sectionForPhase('straight', true, null)).toBe('game1');
    expect(sectionForPhase('discussion', false, 'before_game1')).toBe('discussion_before_game1');
    expect(sectionForPhase('discussion', false, 'after_game1')).toBe('discussion_after_game1');
    expect(sectionForPhase('freewater', false, null)).toBe('game2_prep');
    expect(sectionForPhase('freewater', true, null)).toBe('game2');
    expect(sectionForPhase('leaderboard', false, null)).toBeNull();
  });

  it('shows time left, then zero, then a growing negative', () => {
    expect(formatSectionClock(240000)).toBe('4:00');
    expect(formatSectionClock(239001)).toBe('4:00');
    expect(formatSectionClock(239000)).toBe('3:59');
    expect(formatSectionClock(1)).toBe('0:01');
    expect(formatSectionClock(0)).toBe('0:00');
    expect(formatSectionClock(-999)).toBe('0:00');
    expect(formatSectionClock(-1000)).toBe('-0:01');
    expect(formatSectionClock(-75000)).toBe('-1:15');
  });

  it('holds the joining clock until the first player joins or the facilitator starts it', () => {
    const { session, wait } = makeSession();
    wait(60000);
    const waiting = session.getPublicSnapshot().sectionClock;
    expect(waiting).toMatchObject({ section: 'joining', running: false, elapsedMs: 0, remainingMs: 240000 });

    joinAndCalibrate(session, 'a', 1);
    wait(30000);
    expect(session.getPublicSnapshot().sectionClock).toMatchObject({ running: true, remainingMs: 210000 });

    // A second player does not restart it
    joinAndCalibrate(session, 'b', 1);
    wait(10000);
    expect(session.getPublicSnapshot().sectionClock.remainingMs).toBe(200000);

    const other = makeSession();
    other.wait(5000);
    expect(other.session.executeHostCommand({ commandId: 'go', type: 'restart_section_clock' }).ok).toBe(true);
    other.wait(15000);
    expect(other.session.getPublicSnapshot().sectionClock).toMatchObject({ running: true, remainingMs: 225000 });
  });

  it('restarts from the full planned time whenever a phase is loaded', () => {
    const { session, wait } = makeSession();
    joinAndCalibrate(session, 'a', 1);
    wait(500000);
    expect(session.getPublicSnapshot().sectionClock.remainingMs).toBeLessThan(0);

    const steps = [
      [{ phase: 'training' }, 'training'],
      [{ phase: 'straight', scoringEnabled: false }, 'game1_prep'],
      [{ phase: 'discussion', discussionTopic: 'before_game1' }, 'discussion_before_game1'],
      [{ phase: 'straight', scoringEnabled: true }, 'game1'],
      [{ phase: 'discussion', discussionTopic: 'after_game1' }, 'discussion_after_game1'],
      [{ phase: 'freewater', scoringEnabled: false }, 'game2_prep'],
      [{ phase: 'freewater', scoringEnabled: true }, 'game2'],
    ] as const;
    steps.forEach(([load, section], i) => {
      expect(session.executeHostCommand({ commandId: `plan_${i}`, type: 'load_phase', ...load }).ok).toBe(true);
      const fresh = session.getPublicSnapshot().sectionClock;
      expect(fresh).toMatchObject({
        section,
        running: true,
        elapsedMs: 0,
        budgetSec: SECTION_BUDGET_DEFAULTS_SEC[section],
        remainingMs: SECTION_BUDGET_DEFAULTS_SEC[section] * 1000,
      });
      wait(7000);
      expect(session.getPublicSnapshot().sectionClock.remainingMs).toBe(SECTION_BUDGET_DEFAULTS_SEC[section] * 1000 - 7000);
    });

    session.executeHostCommand({ commandId: 'plan_lb', type: 'load_phase', phase: 'leaderboard' });
    expect(session.getPublicSnapshot().sectionClock.section).toBeNull();
  });

  it('runs into the minus without ending anything outside the two scored games', () => {
    const { session, wait } = makeSession();
    joinAndCalibrate(session, 'a', 1);

    session.executeHostCommand({ commandId: 't', type: 'load_phase', phase: 'training' });
    session.executeHostCommand({ commandId: 'ts', type: 'start_phase' });
    wait(SECTION_BUDGET_DEFAULTS_SEC.training * 1000 + 45000);
    let snap = session.getPublicSnapshot();
    expect(snap.phase).toBe('training');
    expect(snap.runStatus).toBe('running');
    expect(snap.sectionClock.remainingMs).toBe(-45000);

    session.executeHostCommand({ commandId: 'd', type: 'load_phase', phase: 'discussion', discussionTopic: 'after_game1' });
    wait(SECTION_BUDGET_DEFAULTS_SEC.discussion_after_game1 * 1000 + 600000);
    snap = session.getPublicSnapshot();
    expect(snap.phase).toBe('discussion');
    expect(snap.sectionClock.remainingMs).toBe(-600000);

    // Both prep rounds keep running long after their planned time
    for (const [id, phase, section] of [
      ['p1', 'straight', 'game1_prep'],
      ['p2', 'freewater', 'game2_prep'],
    ] as const) {
      session.executeHostCommand({ commandId: id, type: 'load_phase', phase, scoringEnabled: false });
      session.executeHostCommand({ commandId: `${id}s`, type: 'start_phase' });
      for (let i = 0; i < SECTION_BUDGET_DEFAULTS_SEC[section] + 240; i++) wait(1000);
      snap = session.getPublicSnapshot();
      expect(snap.runStatus).toBe('running');
      expect(snap.sectionClock.remainingMs).toBe(-240000);
      expect(snap.leaderboard.standings).toHaveLength(0);
    }
  });

  it('ends Game 2 at zero, counted from when the phase was loaded', () => {
    const { session, wait } = makeSession();
    joinAndCalibrate(session, 'a', 1);
    session.executeHostCommand({ commandId: 'g', type: 'load_phase', phase: 'freewater', scoringEnabled: true });
    // 40 s of staging before the facilitator presses Start: it comes out of the five minutes
    wait(40000);
    session.executeHostCommand({ commandId: 'gs', type: 'start_phase', overrideWarnings: true });
    wait(3000);
    for (let i = 0; i < 256; i++) wait(1000);
    let snap = session.getPublicSnapshot();
    expect(snap.runStatus).toBe('running');
    expect(snap.sectionClock.remainingMs).toBe(1000);

    wait(1000);
    snap = session.getPublicSnapshot();
    expect(snap.runStatus).toBe('finished');
    expect(snap.leaderboard.freewater?.endedBy).toBe('time_up');
    // 300 s planned - 40 s staging - 3 s countdown = 257 s of play, less the tick in which time ran out
    // (1 s in this test, 1/60 s on the real server)
    expect(snap.leaderboard.freewater?.activeElapsedMs).toBe(256000);

    // The clock keeps showing how far over the section is while results are on screen
    wait(20000);
    expect(session.getPublicSnapshot().sectionClock.remainingMs).toBe(-20000);
    expect(session.getPublicSnapshot().runStatus).toBe('finished');
  });

  it('moves the end of a live scored game when the planned time changes or the clock restarts', () => {
    const { session, wait } = makeSession();
    joinAndCalibrate(session, 'a', 1);
    session.executeHostCommand({ commandId: 'g', type: 'load_phase', phase: 'freewater', scoringEnabled: true });
    session.executeHostCommand({ commandId: 'gs', type: 'start_phase', overrideWarnings: true });
    wait(3000);
    for (let i = 0; i < 290; i++) wait(1000);
    // 7 s left: one more minute
    session.executeHostCommand({ commandId: 'b', type: 'set_section_budget', section: 'game2', budgetSec: 360 });
    for (let i = 0; i < 60; i++) wait(1000);
    expect(session.getPublicSnapshot().runStatus).toBe('running');
    expect(session.getPublicSnapshot().sectionClock.remainingMs).toBe(7000);
    // 7 s left again: start the six minutes over
    session.executeHostCommand({ commandId: 'r', type: 'restart_section_clock' });
    for (let i = 0; i < 359; i++) wait(1000);
    expect(session.getPublicSnapshot().runStatus).toBe('running');
    wait(1000);
    expect(session.getPublicSnapshot().runStatus).toBe('finished');
    expect(session.getPublicSnapshot().leaderboard.freewater?.endedBy).toBe('time_up');

    // Shortening the time below what has already passed ends a live game at the next tick
    session.executeHostCommand({ commandId: 'g1', type: 'load_phase', phase: 'straight', scoringEnabled: true });
    session.executeHostCommand({ commandId: 'g1s', type: 'start_phase', overrideWarnings: true });
    wait(3000);
    for (let i = 0; i < 57; i++) wait(1000);
    session.executeHostCommand({ commandId: 'b1', type: 'set_section_budget', section: 'game1', budgetSec: 30 });
    expect(session.getPublicSnapshot().runStatus).toBe('running');
    wait(100);
    expect(session.getPublicSnapshot().runStatus).toBe('finished');
    expect(session.getPublicSnapshot().leaderboard.straight?.endedBy).toBe('time_up');
  });

  it('does not end a scored game the instant it starts when the section time was already used up', () => {
    const { session, wait } = makeSession();
    joinAndCalibrate(session, 'a', 1);
    session.executeHostCommand({ commandId: 'g', type: 'load_phase', phase: 'freewater', scoringEnabled: true });
    // The whole five minutes pass while the round is still staged
    for (let i = 0; i < 320; i++) wait(1000);
    expect(session.getPublicSnapshot().runStatus).toBe('ready');
    const started = session.executeHostCommand({ commandId: 'gs', type: 'start_phase', overrideWarnings: true });
    expect(started.ok).toBe(true);
    expect(started.message).toMatch(/will not end by itself/);
    wait(3000);
    for (let i = 0; i < 120; i++) wait(1000);
    expect(session.getPublicSnapshot().runStatus).toBe('running');

    // Giving the clock time again brings the automatic end back
    session.executeHostCommand({ commandId: 'r', type: 'restart_section_clock' });
    for (let i = 0; i < 299; i++) wait(1000);
    expect(session.getPublicSnapshot().runStatus).toBe('running');
    wait(1000);
    expect(session.getPublicSnapshot().runStatus).toBe('finished');
    expect(session.getPublicSnapshot().leaderboard.freewater?.endedBy).toBe('time_up');

    // A round reset after time ran out starts unarmed too
    expect(session.executeHostCommand({ commandId: 'rr', type: 'reset_scored_round' }).ok).toBe(true);
    session.executeHostCommand({ commandId: 'gs2', type: 'start_phase', overrideWarnings: true });
    wait(3000);
    for (let i = 0; i < 30; i++) wait(1000);
    expect(session.getPublicSnapshot().runStatus).toBe('running');
  });

  it('holds a paused scored game when time runs out and ends it on resume', () => {
    const { session, wait } = makeSession();
    joinAndCalibrate(session, 'a', 1);
    session.executeHostCommand({ commandId: 'g', type: 'load_phase', phase: 'straight', scoringEnabled: true });
    session.executeHostCommand({ commandId: 'gs', type: 'start_phase', overrideWarnings: true });
    wait(3000);
    for (let i = 0; i < 200; i++) wait(1000);
    session.executeHostCommand({ commandId: 'p', type: 'pause_phase' });
    for (let i = 0; i < 100; i++) wait(1000);
    expect(session.getPublicSnapshot().runStatus).toBe('paused');
    expect(session.getPublicSnapshot().sectionClock.remainingMs).toBeLessThan(0);
    session.executeHostCommand({ commandId: 'rs', type: 'resume_phase' });
    wait(100);
    const done = session.getPublicSnapshot();
    expect(done.runStatus).toBe('finished');
    expect(done.leaderboard.straight?.endedBy).toBe('time_up');
  });

  it('keeps counting through a pause and through a round reset', () => {
    const { session, wait } = makeSession();
    joinAndCalibrate(session, 'a', 1);
    session.executeHostCommand({ commandId: 'g', type: 'load_phase', phase: 'straight', scoringEnabled: true });
    session.executeHostCommand({ commandId: 'gs', type: 'start_phase', overrideWarnings: true });
    wait(3000);
    wait(10000);
    session.executeHostCommand({ commandId: 'p', type: 'pause_phase' });
    const activeAtPause = session.getPublicSnapshot().round.activeElapsedMs;
    wait(20000);
    let snap = session.getPublicSnapshot();
    // Class time went on, round time did not
    expect(snap.sectionClock.elapsedMs).toBe(33000);
    expect(snap.round.activeElapsedMs).toBe(activeAtPause);

    expect(session.executeHostCommand({ commandId: 'r', type: 'reset_scored_round' }).ok).toBe(true);
    wait(2000);
    snap = session.getPublicSnapshot();
    expect(snap.runStatus).toBe('ready');
    expect(snap.sectionClock.elapsedMs).toBe(35000);
  });

  it('lets the facilitator change a planned time or restart the clock, and nothing else moves', () => {
    const { session, wait } = makeSession();
    joinAndCalibrate(session, 'a', 1);
    session.executeHostCommand({ commandId: 'g', type: 'load_phase', phase: 'freewater', scoringEnabled: true });
    session.executeHostCommand({ commandId: 'gs', type: 'start_phase', overrideWarnings: true });
    wait(3000);
    wait(27000);
    const before = session.getPublicSnapshot();

    expect(
      session.executeHostCommand({ commandId: 'b1', type: 'set_section_budget', section: 'game2', budgetSec: 360 }).ok,
    ).toBe(true);
    let snap = session.getPublicSnapshot();
    expect(snap.sectionClock).toMatchObject({ budgetSec: 360, elapsedMs: 30000, remainingMs: 330000 });
    expect(snap.runStatus).toBe('running');
    expect(snap.round.roundId).toBe(before.round.roundId);
    expect(snap.inputEpoch).toBe(before.inputEpoch);

    // Another section's time can be set ahead of reaching it
    session.executeHostCommand({ commandId: 'b2', type: 'set_section_budget', section: 'training', budgetSec: 90 });
    expect(session.getPublicSnapshot().sectionBudgetsSec.training).toBe(90);
    expect(session.getPublicSnapshot().sectionClock.budgetSec).toBe(360);

    for (const [id, payload] of [
      ['bad1', { section: 'game2', budgetSec: 5 }],
      ['bad2', { section: 'game2', budgetSec: 99999 }],
      ['bad3', { section: 'game2', budgetSec: Number.NaN }],
      ['bad4', { section: 'nonsense', budgetSec: 60 }],
    ] as const) {
      const res = session.executeHostCommand({ commandId: id, type: 'set_section_budget', ...payload } as never);
      expect(res.ok).toBe(false);
    }
    expect(session.getPublicSnapshot().sectionBudgetsSec.game2).toBe(360);

    expect(session.executeHostCommand({ commandId: 'rs', type: 'restart_section_clock' }).ok).toBe(true);
    snap = session.getPublicSnapshot();
    expect(snap.sectionClock).toMatchObject({ elapsedMs: 0, remainingMs: 360000 });
    expect(snap.runStatus).toBe('running');
    expect(snap.round.roundId).toBe(before.round.roundId);

    session.executeHostCommand({ commandId: 'ge', type: 'end_round' });
    session.executeHostCommand({ commandId: 'lb', type: 'load_phase', phase: 'leaderboard' });
    expect(session.executeHostCommand({ commandId: 'rs2', type: 'restart_section_clock' }).code).toBe('NO_SECTION_CLOCK');

    // A cleared session returns to a waiting joining clock but keeps the facilitator's planned times
    session.executeHostCommand({ commandId: 'clr', type: 'clear_session', confirmClearSession: true });
    snap = session.getPublicSnapshot();
    expect(snap.sectionClock).toMatchObject({ section: 'joining', running: false, remainingMs: 240000 });
    expect(snap.sectionBudgetsSec.game2).toBe(360);
    expect(snap.sectionBudgetsSec.training).toBe(90);
  });
});

describe('Revision 0.6 — catch-up item placement, music volume, and player emoji', () => {
  type Internals = {
    teams: Map<number, { sim: { x: number; y: number; score: number } }>;
    findFairItemPosition: (variant: 'glow_seed' | 'golden_bug' | 'pond_star') => { x: number; y: number };
  };

  /** A running Game 2 with `teamCount` teams of two, and direct access to scores and item placement. */
  function runningHarvest(teamCount: number) {
    const session = new ClassroomGameSession({ initialMinTeamSize: 1, initialMaxTeamSize: 6 });
    for (let t = 1; t <= teamCount; t++) {
      joinAndCalibrate(session, `t${t}a`, t);
      joinAndCalibrate(session, `t${t}b`, t);
    }
    session.executeHostCommand({ commandId: 'l', type: 'load_phase', phase: 'freewater', scoringEnabled: true, seed: 77 });
    session.executeHostCommand({ commandId: 's', type: 'start_phase', overrideWarnings: true });
    session.stepSimulation(3000);
    expect(session.getPublicSnapshot().runStatus).toBe('running');
    const inner = session as unknown as Internals;
    const place = (variant: 'glow_seed' | 'golden_bug' | 'pond_star', n: number) =>
      Array.from({ length: n }, () => inner.findFairItemPosition.call(session, variant));
    const distTo = (team: number, pos: { x: number; y: number }) => {
      const sim = inner.teams.get(team)!.sim;
      return Math.hypot(sim.x - pos.x, sim.y - pos.y);
    };
    return { session, inner, place, distTo };
  }

  it('puts a star close to the lowest-scoring team, a golden bug further out, and seeds anywhere', () => {
    const { inner, place, distTo } = runningHarvest(2);
    inner.teams.get(1)!.sim.score = 2000;
    inner.teams.get(2)!.sim.score = 300;

    const star = POND_ITEMS.pond_star.nearTrailingTeam!;
    const bug = POND_ITEMS.golden_bug.nearTrailingTeam!;
    expect(POND_ITEMS.glow_seed.nearTrailingTeam).toBeNull();
    // The more it is worth, the nearer: the star's ring lies inside the bug's
    expect(star.maxDist).toBeLessThanOrEqual(bug.minDist);

    for (const pos of place('pond_star', 200)) {
      const d = distTo(2, pos);
      expect(d).toBeGreaterThanOrEqual(star.minDist - 1);
      expect(d).toBeLessThanOrEqual(star.maxDist + 1);
      expect(d).toBeLessThan(distTo(1, pos));
    }
    for (const pos of place('golden_bug', 200)) {
      const d = distTo(2, pos);
      expect(d).toBeGreaterThanOrEqual(bug.minDist - 1);
      expect(d).toBeLessThanOrEqual(bug.maxDist + 1);
      expect(d).toBeLessThan(distTo(1, pos));
    }
    // Seeds are not steered: plenty land nearer the leader, and plenty beyond the bug ring
    const seeds = place('glow_seed', 300);
    expect(seeds.filter((pos) => distTo(1, pos) < distTo(2, pos)).length).toBeGreaterThan(60);
    expect(seeds.filter((pos) => distTo(2, pos) > bug.maxDist).length).toBeGreaterThan(60);

    // The lead changes hands, and so does the help
    inner.teams.get(2)!.sim.score = 5000;
    for (const pos of place('pond_star', 100)) {
      expect(distTo(1, pos)).toBeLessThanOrEqual(star.maxDist + 1);
    }
  });

  it('steers nothing while the scores are level, and shares the help between teams tied for last', () => {
    const { inner, place, distTo } = runningHarvest(3);
    const star = POND_ITEMS.pond_star.nearTrailingTeam!;

    // 0 : 0 : 0, as at the start of every round
    const level = place('pond_star', 300);
    const nearSomeone = level.filter((pos) => [1, 2, 3].some((t) => distTo(t, pos) <= star.maxDist)).length;
    expect(nearSomeone).toBeLessThan(240);

    // Team 1 ahead, Teams 2 and 3 tied for last: both get stars, the leader gets none
    inner.teams.get(1)!.sim.score = 900;
    const helped = { 2: 0, 3: 0 };
    for (const pos of place('pond_star', 300)) {
      const nearest = [1, 2, 3].reduce((best, t) => (distTo(t, pos) < distTo(best, pos) ? t : best), 1);
      expect(nearest).not.toBe(1);
      helped[nearest as 2 | 3] += 1;
    }
    expect(helped[2]).toBeGreaterThan(60);
    expect(helped[3]).toBeGreaterThan(60);
  });

  it('applies the rule to items that respawn during a real round', () => {
    const { session, inner } = runningHarvest(2);
    const star = POND_ITEMS.pond_star.nearTrailingTeam!;
    const bug = POND_ITEMS.golden_bug.nearTrailingTeam!;
    const leader = inner.teams.get(1)!.sim;
    const trailing = inner.teams.get(2)!.sim;
    const home = { x: leader.x, y: leader.y };

    // Team 1 keeps collecting (dropped onto an item, then sent home); Team 2 never moves or scores
    const known = new Map<string, string>();
    for (const it of session.getPublicSnapshot().round.items) known.set(it.itemId, `${it.variant}@${it.x},${it.y}`);
    let steered = 0;
    for (let i = 0; i < 400 && steered < 12; i++) {
      const target = session.getPublicSnapshot().round.items.find((it) => it.available)!;
      leader.x = target.x;
      leader.y = target.y;
      session.stepSimulation(20);
      leader.x = home.x;
      leader.y = home.y;
      session.stepSimulation(GAME_DEFAULTS.itemRespawnDelayMs + 20);
      for (const it of session.getPublicSnapshot().round.items) {
        const signature = `${it.variant}@${it.x},${it.y}`;
        if (!it.available || known.get(it.itemId) === signature) continue;
        known.set(it.itemId, signature);
        const ring = it.variant === 'pond_star' ? star : it.variant === 'golden_bug' ? bug : null;
        if (!ring) continue;
        const d = Math.hypot(trailing.x - it.x, trailing.y - it.y);
        expect(d).toBeGreaterThanOrEqual(ring.minDist - 1);
        expect(d).toBeLessThanOrEqual(ring.maxDist + 1);
        steered += 1;
      }
    }
    expect(steered).toBeGreaterThanOrEqual(12);
    expect(session.getPublicSnapshot().teams[0].sim.score).toBeGreaterThan(0);
    expect(session.getPublicSnapshot().teams[1].sim.score).toBe(0);
  });

  it('never drops an item on a creature, on another item, or outside the pond', () => {
    const { session, inner, place } = runningHarvest(4);
    inner.teams.get(1)!.sim.score = 1000;
    inner.teams.get(2)!.sim.score = 400;
    inner.teams.get(3)!.sim.score = 400;
    const round = session.getPublicSnapshot().round;
    const clearOfCreature = GAME_DEFAULTS.creatureBodyRadius + GAME_DEFAULTS.itemCollisionRadius;
    for (const variant of ['glow_seed', 'golden_bug', 'pond_star'] as const) {
      for (const pos of place(variant, 150)) {
        expect(pos.x).toBeGreaterThan(0);
        expect(pos.x).toBeLessThan(round.arenaWidth);
        expect(pos.y).toBeGreaterThan(0);
        expect(pos.y).toBeLessThan(round.arenaHeight);
        for (const team of inner.teams.values()) {
          expect(Math.hypot(team.sim.x - pos.x, team.sim.y - pos.y)).toBeGreaterThan(clearOfCreature);
        }
        for (const it of round.items) {
          expect(Math.hypot(it.x - pos.x, it.y - pos.y)).toBeGreaterThan(GAME_DEFAULTS.itemCollisionRadius * 2);
        }
      }
    }
  });

  it('keeps the same seed producing the same pond', () => {
    const itemsFor = () => {
      const session = new ClassroomGameSession({ initialMinTeamSize: 1, initialMaxTeamSize: 6 });
      joinAndCalibrate(session, 'a', 1);
      joinAndCalibrate(session, 'b', 2);
      session.executeHostCommand({ commandId: 'l', type: 'load_phase', phase: 'freewater', scoringEnabled: true, seed: 4242 });
      return session.getPublicSnapshot().round.items.map((it) => `${it.variant}@${it.x},${it.y}`);
    };
    expect(itemsFor()).toEqual(itemsFor());
  });

  it('sets the music volume from Mission Control, 70% by default, kept across a session clear', () => {
    const session = new ClassroomGameSession();
    expect(MUSIC_VOLUME_DEFAULT).toBe(70);
    expect(session.getPublicSnapshot().musicVolume).toBe(70);
    expect(session.executeHostCommand({ commandId: 'v1', type: 'set_music_volume', volume: 35 }).ok).toBe(true);
    expect(session.getPublicSnapshot().musicVolume).toBe(35);
    expect(session.executeHostCommand({ commandId: 'v2', type: 'set_music_volume', volume: 0 }).ok).toBe(true);
    expect(session.getPublicSnapshot().musicVolume).toBe(0);
    for (const [id, volume] of [
      ['b1', -1],
      ['b2', 101],
      ['b3', Number.NaN],
      ['b4', 'loud' as unknown as number],
    ] as const) {
      expect(session.executeHostCommand({ commandId: id, type: 'set_music_volume', volume }).ok).toBe(false);
    }
    expect(session.getPublicSnapshot().musicVolume).toBe(0);
    session.executeHostCommand({ commandId: 'v3', type: 'set_music_volume', volume: 88 });
    // The switch and the slider are independent
    expect(session.getPublicSnapshot().musicEnabled).toBe(false);
    session.executeHostCommand({ commandId: 'clr', type: 'clear_session', confirmClearSession: true });
    expect(session.getPublicSnapshot().musicVolume).toBe(88);
  });

  it('offers a pool of distinct single-glyph emoji that avoids game symbols', () => {
    expect(new Set(PLAYER_EMOJI_POOL).size).toBe(PLAYER_EMOJI_POOL.length);
    expect(PLAYER_EMOJI_POOL.length).toBeGreaterThanOrEqual(40);
    for (const emoji of PLAYER_EMOJI_POOL) {
      // One code point each: no variation selectors, skin tones, or joined sequences
      expect(Array.from(emoji)).toHaveLength(1);
    }
    for (const reserved of ['⭐', '🌟', '✨', '🐞', '🌱', '✅', '✔', '❌']) {
      expect(PLAYER_EMOJI_POOL).not.toContain(reserved);
    }
  });

  it('gives all 30 players a different emoji, shown on their limb and their phone', () => {
    const session = new ClassroomGameSession({ initialMinTeamSize: 1, initialMaxTeamSize: 6 });
    const seats: PlayerPrivateSeat[] = [];
    for (let i = 0; i < 30; i++) seats.push(joinAndCalibrate(session, `e${i}`, 1 + (i % 5)));
    const emoji = seats.map((seat) => seat.playerEmoji);
    for (const e of emoji) expect(PLAYER_EMOJI_POOL).toContain(e);
    expect(new Set(emoji).size).toBe(30);

    const snap = session.getPublicSnapshot();
    for (const seat of seats) {
      const limb = snap.teams
        .find((t) => t.teamNumber === seat.teamNumber)!
        .limbs.find((l) => l.assignedPlayerId === seat.playerId)!;
      expect(limb.playerEmoji).toBe(seat.playerEmoji);
    }
    const roster = session.getHostSnapshot().players;
    expect(roster.map((p) => p.playerEmoji).sort()).toEqual([...emoji].sort());
  });

  it('assigns emoji at random rather than by join order', () => {
    const firstEmoji = new Set<string>();
    for (let run = 0; run < 40; run++) {
      const session = new ClassroomGameSession({ initialMinTeamSize: 1, initialMaxTeamSize: 6 });
      firstEmoji.add(joinAndCalibrate(session, `r${run}`, 1).playerEmoji);
    }
    expect(firstEmoji.size).toBeGreaterThan(5);
  });

  it('keeps a player\'s emoji through a reconnect and through losing and regaining their limb', () => {
    const clock = { nowMs: 1000 };
    const session = new ClassroomGameSession({ nowFn: () => clock.nowMs, initialMinTeamSize: 1, initialMaxTeamSize: 6 });
    const a = joinAndCalibrate(session, 'a', 1);
    const b = joinAndCalibrate(session, 'b', 1);

    // Quick refresh
    session.handleSocketDisconnect('a');
    const quick = session.resumePlayer('a2', a.resumeToken);
    expect(quick.ok).toBe(true);
    expect(quick.data!.playerEmoji).toBe(a.playerEmoji);

    // Gone long enough to lose the limb, then back
    session.handleSocketDisconnect('b');
    clock.nowMs += GAME_DEFAULTS.disconnectedLimbGraceMs + 1000;
    session.stepSimulation(100);
    expect(session.getPublicSnapshot().teams[0].limbCount).toBe(1);
    // A newcomer meanwhile does not get the away player's emoji
    const c = joinAndCalibrate(session, 'c', 1);
    expect(c.playerEmoji).not.toBe(b.playerEmoji);
    const back = session.resumePlayer('b2', b.resumeToken);
    expect(back.ok).toBe(true);
    expect(back.data!.playerEmoji).toBe(b.playerEmoji);
    const limbs = session.getPublicSnapshot().teams[0].limbs;
    expect(limbs.map((l) => l.playerEmoji).sort()).toEqual([a.playerEmoji, b.playerEmoji, c.playerEmoji].sort());
  });
});

describe('Revision 0.7 — the guide is revealed step by step from Mission Control', () => {
  it('orders the reveal: the game idea, steps 1 to 3, and the QR code last', () => {
    expect(GUIDE_STEPS.map((st) => st.id)).toEqual(['game', 'join', 'motion', 'sweeps', 'qr']);
  });

  it('opens a fresh session on the first card and reveals more only on the facilitator\'s command', () => {
    const clock = { nowMs: 1000 };
    const session = new ClassroomGameSession({ nowFn: () => clock.nowMs, initialMinTeamSize: 1, initialMaxTeamSize: 6 });
    const step = (n: number, id: string) => session.executeHostCommand({ commandId: id, type: 'set_guide_step', step: n });
    expect(session.getPublicSnapshot()).toMatchObject({ guideVisible: true, guideStep: 1 });

    // Nothing reveals itself: time passing and a player joining leave the guide where it is
    clock.nowMs += 600000;
    session.stepSimulation(1000);
    joinAndCalibrate(session, 'early', 1);
    expect(session.getPublicSnapshot().guideStep).toBe(1);

    for (let n = 2; n <= GUIDE_STEPS.length; n++) {
      expect(step(n, `fwd${n}`).ok).toBe(true);
      expect(session.getPublicSnapshot().guideStep).toBe(n);
    }
    // Back is allowed (hides the QR code again), and any step can be jumped to
    expect(step(3, 'back').ok).toBe(true);
    expect(session.getPublicSnapshot().guideStep).toBe(3);

    for (const [id, n] of [
      ['bad0', 0],
      ['bad6', GUIDE_STEPS.length + 1],
      ['badNaN', Number.NaN],
      ['badStr', 'next' as unknown as number],
    ] as const) {
      expect(step(n, id).code).toBe('INVALID_GUIDE_STEP');
    }
    expect(session.getPublicSnapshot().guideStep).toBe(3);
  });

  it('keeps its place when the guide is hidden and shown, and starts over only with a cleared session', () => {
    const session = new ClassroomGameSession({ initialMinTeamSize: 1, initialMaxTeamSize: 6 });
    session.executeHostCommand({ commandId: 's', type: 'set_guide_step', step: 4 });
    session.executeHostCommand({ commandId: 'h', type: 'set_guide_visible', visible: false });
    session.executeHostCommand({ commandId: 'v', type: 'set_guide_visible', visible: true });
    expect(session.getPublicSnapshot()).toMatchObject({ guideVisible: true, guideStep: 4 });

    // Stepping does not show a hidden guide or disturb a phase
    session.executeHostCommand({ commandId: 'l', type: 'load_phase', phase: 'training' });
    session.executeHostCommand({ commandId: 'st', type: 'start_phase' });
    expect(session.executeHostCommand({ commandId: 's5', type: 'set_guide_step', step: 5 }).ok).toBe(true);
    expect(session.getPublicSnapshot()).toMatchObject({ guideVisible: false, guideStep: 5, phase: 'training', runStatus: 'running' });

    session.executeHostCommand({ commandId: 'clr', type: 'clear_session', confirmClearSession: true });
    expect(session.getPublicSnapshot()).toMatchObject({ guideVisible: true, guideStep: 1 });
  });

  it('starts the joining clock when the explanation begins, before anyone has joined', () => {
    const clock = { nowMs: 1000 };
    const session = new ClassroomGameSession({ nowFn: () => clock.nowMs });
    clock.nowMs += 90000;
    expect(session.getPublicSnapshot().sectionClock.running).toBe(false);
    session.executeHostCommand({ commandId: 'g2', type: 'set_guide_step', step: 2 });
    expect(session.getPublicSnapshot().sectionClock).toMatchObject({ section: 'joining', running: true, elapsedMs: 0 });
    clock.nowMs += 30000;
    // Later steps do not restart it
    session.executeHostCommand({ commandId: 'g3', type: 'set_guide_step', step: 3 });
    expect(session.getPublicSnapshot().sectionClock.elapsedMs).toBe(30000);

    // Returning to the first card on a fresh session does not start it
    const other = new ClassroomGameSession({ nowFn: () => clock.nowMs });
    other.executeHostCommand({ commandId: 'g1', type: 'set_guide_step', step: 1 });
    expect(other.getPublicSnapshot().sectionClock.running).toBe(false);
  });

  it('loading the Explanation starts it from the first card and starts the joining clock', () => {
    const clock = { nowMs: 1000 };
    const session = new ClassroomGameSession({ nowFn: () => clock.nowMs, initialMinTeamSize: 1, initialMaxTeamSize: 6 });
    const wait = (ms: number) => {
      clock.nowMs += ms;
      session.stepSimulation(ms);
    };
    wait(120000);
    expect(session.getPublicSnapshot().sectionClock.running).toBe(false);

    // Load Phase on step 1 of the session list
    expect(
      session.executeHostCommand({ commandId: 'load', type: 'set_guide_visible', visible: true, fromStart: true }).ok,
    ).toBe(true);
    expect(session.getPublicSnapshot()).toMatchObject({ guideVisible: true, guideStep: 1 });
    expect(session.getPublicSnapshot().sectionClock).toMatchObject({ section: 'joining', running: true, remainingMs: 240000 });

    // The clock runs on through every reveal; stepping never restarts it
    wait(20000);
    for (let n = 2; n <= GUIDE_STEPS.length; n++) {
      session.executeHostCommand({ commandId: `n${n}`, type: 'set_guide_step', step: n });
      wait(10000);
    }
    expect(session.getPublicSnapshot().sectionClock.remainingMs).toBe(240000 - 20000 - 40000);

    // The plain show/hide toggle keeps both the place and the clock
    session.executeHostCommand({ commandId: 'h', type: 'set_guide_visible', visible: false });
    session.executeHostCommand({ commandId: 'v', type: 'set_guide_visible', visible: true });
    expect(session.getPublicSnapshot().guideStep).toBe(GUIDE_STEPS.length);
    expect(session.getPublicSnapshot().sectionClock.remainingMs).toBe(180000);

    // Loading it again is a fresh start, like loading any phase twice
    joinAndCalibrate(session, 'a', 1);
    session.executeHostCommand({ commandId: 'load2', type: 'set_guide_visible', visible: true, fromStart: true });
    expect(session.getPublicSnapshot()).toMatchObject({ guideStep: 1 });
    expect(session.getPublicSnapshot().sectionClock.remainingMs).toBe(240000);

    // Over another phase it rewinds the guide but leaves that phase's clock alone
    session.executeHostCommand({ commandId: 't', type: 'load_phase', phase: 'training' });
    wait(30000);
    session.executeHostCommand({ commandId: 's', type: 'set_guide_step', step: 4 });
    session.executeHostCommand({ commandId: 'load3', type: 'set_guide_visible', visible: true, fromStart: true });
    expect(session.getPublicSnapshot()).toMatchObject({ phase: 'training', guideVisible: true, guideStep: 1 });
    expect(session.getPublicSnapshot().sectionClock).toMatchObject({ section: 'training', remainingMs: 90000 });
  });
});
