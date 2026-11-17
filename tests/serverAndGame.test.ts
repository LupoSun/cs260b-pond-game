import { describe, expect, it } from 'vitest';
import { ClassroomGameSession } from '../src/server/gameSession.js';
import type { CalibrationSummary, HostCommandPayload, PlayerPrivateSeat } from '../src/shared/types.js';

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

  it('toggles the classroom guide by host command and hides it when a phase starts', () => {
    const session = new ClassroomGameSession();
    expect(session.getPublicSnapshot().guideVisible).toBe(false);

    const show = (visible: boolean, id: string) =>
      session.executeHostCommand({ commandId: id, type: 'set_guide_visible', visible });

    expect(show(true, 'g1').ok).toBe(true);
    expect(session.getPublicSnapshot().guideVisible).toBe(true);

    session.executeHostCommand({ commandId: 'g2', type: 'load_phase', phase: 'training' });
    expect(session.getPublicSnapshot().guideVisible).toBe(true);
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

    // Pause for 20 seconds -> remaining time MUST NOT change, and pre-pause inputEpoch is invalidated after resume!
    const prePauseEpoch = runningSnap.inputEpoch;
    const remBeforePause = session.getPublicSnapshot().round.remainingMs;
    session.executeHostCommand({ commandId: 'c3', type: 'pause_phase' });

    nowMs += 20000;
    session.stepSimulation(20000);
    expect(session.getPublicSnapshot().round.remainingMs).toBe(remBeforePause);

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

    // Must still be baseCycleForwardImpulse / 5 (3.6), NOT / 4 (4.5)!
    expect(session.getPublicSnapshot().teams[4].sim.vx).toBeCloseTo(18.0 / 5, 5);
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
    expect(after.teams[0].sim.score).toBe(1);
    expect(after.teams[1].sim.score).toBe(0);
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

    // Straight race timeout ranking check (90s limit so Team 1 finishes and Team 2/3 time out)
    const p1b = joinAndCalibrate(session, 's1_b', 1);
    const p1c = joinAndCalibrate(session, 's1_c', 1);
    const p1d = joinAndCalibrate(session, 's1_d', 1);

    session.executeHostCommand({
      commandId: 'sr1',
      type: 'load_phase',
      phase: 'straight',
      durationSec: 90,
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
      if (session.getPublicSnapshot().runStatus === 'finished') break;
    }

    const fin = session.getPublicSnapshot();
    expect(fin.runStatus).toBe('finished');
    expect(fin.teams[0].sim.finished).toBe(true);
    expect(fin.teams[0].sim.rank).toBe(1);
    expect(fin.teams[1].sim.finished).toBe(false);
    expect(fin.teams[1].sim.rank).toBe(2);
    expect(fin.teams[2].sim.finished).toBe(false);
    expect(fin.teams[2].sim.rank).toBe(3);
    expect(fin.teams).toHaveLength(3);
  });
});
