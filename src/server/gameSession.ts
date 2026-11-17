import crypto from 'node:crypto';
import {
  GAME_DEFAULTS,
  GESTURE_ASSIGNMENT_ORDER,
  GESTURE_SPECS,
  MAX_TEAM_NUMBER,
  MAX_TEAM_SIZE_LIMIT,
  MAX_TOTAL_PLAYERS,
  MIN_TEAM_SIZE_LIMIT,
  getLimbLayout,
  getTeamIdentityPreset,
} from '../shared/constants.js';
import type {
  AckResponse,
  ActivityPhase,
  CalibrationSummary,
  GestureId,
  HostCommandPayload,
  HostPlayerDiagnostic,
  HostPrivateSnapshot,
  InputBeginPayload,
  InputEndPayload,
  InputMethod,
  InputPreviewPayload,
  ItemCollectedBroadcast,
  LimbSlotSpec,
  MotionAssignment,
  NetworkPresentationMode,
  PlayerPrivateSeat,
  PondItemPublicState,
  RoundPublicState,
  RunStatus,
  SensorStatus,
  SessionEventLogEntry,
  SessionPublicSnapshot,
  StrokeAcceptedBroadcast,
  StrokeCompletePayload,
  TeamPublicState,
  TeamSimState,
} from '../shared/types.js';
import { PLAYER_NAME_MAX_LENGTH, sanitizePlayerName } from '../shared/playerName.js';
import { createSeededRng } from './prng.js';

interface ActiveAttemptRecord {
  attemptId: string;
  attemptSeq: number;
  startedAtServerMs: number;
  lastUpdatedAtServerMs: number;
  progress: number;
}

interface PlayerRecord {
  playerId: string;
  /** Participant-chosen nickname; fixed for the session like team and limb */
  playerName: string;
  resumeToken: string;
  teamNumber: number;
  limbIndex: number;
  limbLabel: string;
  assignment: MotionAssignment;
  socketId: string | null;
  connected: boolean;
  connectionGeneration: number;
  sensorStatus: SensorStatus;
  calibrated: boolean;
  calibrationVersion: number;
  minRequiredCalibrationVersion: number;
  calibrationSummary: CalibrationSummary | null;
  practiceAcceptedCount: number;
  hasSucceededStroke: boolean;
  inputMethod: InputMethod;
  activeAttempt: ActiveAttemptRecord | null;
  lastAcceptedAtMs: number | null;
  lastStrokeId: string | null;
  lastRecognitionResult: string;
  measuredRttMs: number | null;
  measuredClockOffsetMs: number | null;
}

interface TeamRecord {
  teamNumber: number;
  teamName: string;
  colorHex: string;
  colorName: string;
  accessory: TeamPublicState['accessory'];
  /** Dynamically updated to getLimbLayout(seatPlayerIds.length) whenever a new player joins */
  layout: LimbSlotSpec[];
  /** Joined player IDs in limb order (0..maxTeamSize-1); disconnects preserve membership & limb count */
  seatPlayerIds: string[];
  latestAcknowledgment: TeamPublicState['latestAcknowledgment'];
  sim: TeamSimState;
}

interface InternalItemRecord extends PondItemPublicState {
  respawnRemainingMs: number | null;
}

export interface SessionCallbacks {
  onStrokeAccepted?: (ev: StrokeAcceptedBroadcast) => void;
  onItemCollected?: (ev: ItemCollectedBroadcast) => void;
  onPlayerRecalibrate?: (playerId: string, socketId: string | null, minCalVersion: number) => void;
  onPlayerSuperseded?: (oldSocketId: string) => void;
  onSessionCleared?: () => void;
  onPhaseOrStatusChanged?: (snapshot: SessionPublicSnapshot) => void;
}

function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

export class ClassroomGameSession {
  private sessionId = makeId('sess');
  private stateRevision = 1;
  private phase: ActivityPhase = 'lobby';
  private runStatus: RunStatus = 'ready';
  private inputEpoch = 1;
  private networkMode: NetworkPresentationMode = 'continuous';
  private networkModeVersion = 1;
  private admissionLocked = false;
  private guideVisible = false;
  private minTeamSize: number = GAME_DEFAULTS.defaultMinTeamSize;
  private maxTeamSize: number = GAME_DEFAULTS.defaultMaxTeamSize;

  private publicBaseUrl: string;
  private devSimAvailable: boolean;
  private nowFn: () => number;
  private callbacks: SessionCallbacks;

  private teams = new Map<number, TeamRecord>();
  private players = new Map<string, PlayerRecord>();
  private playersByResumeToken = new Map<string, string>();
  private playersBySocketId = new Map<string, string>();

  // Round & simulation state
  private roundId = makeId('rnd');
  private scoringEnabled = false;
  private pausedForDiscussion = false;
  private seed = 2602026;
  private rng: () => number = createSeededRng(2602026);
  private durationSec: number = GAME_DEFAULTS.straightRaceDurationSec;
  private activeElapsedMs = 0;
  private countdownRemainingMs = 0;
  private nextFinishRank = 1;
  private items: InternalItemRecord[] = [];
  private itemCounter = 0;

  // Deduplication caches
  private acceptedStrokes = new Map<string, AckResponse<{ strokeId: string }>>();
  private acceptedAttemptIds = new Set<string>();
  private processedHostCommands = new Map<string, AckResponse>();
  private eventLog: SessionEventLogEntry[] = [];

  constructor(opts?: {
    publicBaseUrl?: string;
    devSimAvailable?: boolean;
    nowFn?: () => number;
    callbacks?: SessionCallbacks;
    initialMinTeamSize?: number;
    initialMaxTeamSize?: number;
  }) {
    this.publicBaseUrl = opts?.publicBaseUrl ?? '';
    this.devSimAvailable = opts?.devSimAvailable ?? false;
    this.nowFn = opts?.nowFn ?? (() => Math.round(performance.now()));
    this.callbacks = opts?.callbacks ?? {};

    const minS = Math.max(
      MIN_TEAM_SIZE_LIMIT,
      Math.min(MAX_TEAM_SIZE_LIMIT, Math.floor(opts?.initialMinTeamSize ?? GAME_DEFAULTS.defaultMinTeamSize)),
    );
    const maxS = Math.max(
      minS,
      Math.min(MAX_TEAM_SIZE_LIMIT, Math.floor(opts?.initialMaxTeamSize ?? GAME_DEFAULTS.defaultMaxTeamSize)),
    );
    this.minTeamSize = minS;
    this.maxTeamSize = maxS;

    this.logEvent(
      'info',
      `Session ${this.sessionId} initialized (dynamic teams, size range ${this.minTeamSize}–${this.maxTeamSize}, up to ${MAX_TOTAL_PLAYERS} total players).`,
    );
  }

  setCallbacks(callbacks: SessionCallbacks): void {
    this.callbacks = callbacks;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  private bumpRevision(): void {
    this.stateRevision += 1;
  }

  private bumpInputEpoch(): void {
    this.inputEpoch += 1;
    this.clearAllActiveAttempts();
  }

  private clearAllActiveAttempts(): void {
    for (const player of this.players.values()) {
      player.activeAttempt = null;
    }
  }

  private logEvent(level: 'info' | 'warn', message: string): void {
    const nowMs = this.nowFn();
    this.eventLog.unshift({
      id: makeId('evt'),
      atIso: new Date().toISOString(),
      atServerMs: nowMs,
      level,
      message,
    });
    if (this.eventLog.length > 80) {
      this.eventLog.length = 80;
    }
  }

  private getOrCreateDynamicTeam(teamNumber: number): TeamRecord {
    const existing = this.teams.get(teamNumber);
    if (existing) return existing;

    const preset = getTeamIdentityPreset(teamNumber);
    const created: TeamRecord = {
      teamNumber,
      teamName: preset.teamName,
      colorHex: preset.colorHex,
      colorName: preset.colorName,
      accessory: preset.accessory,
      layout: [],
      seatPlayerIds: [],
      latestAcknowledgment: null,
      sim: this.createInitialTeamSim(this.teams.size, Math.max(1, this.teams.size + 1), this.phase),
    };
    this.teams.set(teamNumber, created);
    return created;
  }

  private getSortedJoinedTeams(): TeamRecord[] {
    return [...this.teams.values()]
      .filter((t) => t.seatPlayerIds.length > 0)
      .sort((a, b) => a.teamNumber - b.teamNumber);
  }

  private createInitialTeamSim(
    slotOrderIdx: number,
    totalActiveSlots: number,
    phase: ActivityPhase,
  ): TeamSimState {
    if (phase === 'freewater') {
      const angle = (slotOrderIdx / Math.max(1, totalActiveSlots)) * Math.PI * 2 - Math.PI / 2;
      const ringRadius = 250;
      const cx = GAME_DEFAULTS.arenaWidth / 2 + Math.cos(angle) * ringRadius;
      const cy = GAME_DEFAULTS.arenaHeight / 2 + Math.sin(angle) * ringRadius;
      // Face inward toward arena center so no team starts aimed into a wall
      const heading = angle + Math.PI;
      return {
        x: cx,
        y: cy,
        vx: 0,
        vy: 0,
        headingRad: heading,
        angularVel: 0,
        laneProgress: 0,
        finished: false,
        finishTimeMs: null,
        rank: null,
        score: 0,
        trainingPulse: 0,
      };
    }

    const laneHeight = GAME_DEFAULTS.arenaHeight / Math.max(1, totalActiveSlots);
    const laneY = laneHeight * (slotOrderIdx + 0.5);
    return {
      x: 120,
      y: laneY,
      vx: 0,
      vy: 0,
      headingRad: 0,
      angularVel: 0,
      laneProgress: 0,
      finished: false,
      finishTimeMs: null,
      rank: null,
      score: 0,
      trainingPulse: 0,
    };
  }

  // =========================================================================
  // Participant Join, Reconnect, Sensor & Calibration
  // =========================================================================

  joinPlayer(
    socketId: string,
    requestedTeamNumber: number,
    rawPlayerName: unknown,
  ): AckResponse<PlayerPrivateSeat> {
    if (!Number.isInteger(requestedTeamNumber)) {
      return this.failAck('INVALID_TEAM_NUMBER', 'Enter a whole team number assigned by your facilitator.');
    }

    if (requestedTeamNumber < 1 || requestedTeamNumber > MAX_TEAM_NUMBER) {
      return this.failAck(
        'TEAM_NUMBER_OUT_OF_RANGE',
        `Enter a valid team number between 1 and ${MAX_TEAM_NUMBER}.`,
      );
    }

    const playerName = sanitizePlayerName(rawPlayerName);
    if (!playerName) {
      return this.failAck(
        'INVALID_PLAYER_NAME',
        `Enter a name or nickname (up to ${PLAYER_NAME_MAX_LENGTH} characters) so your team can spot you.`,
      );
    }

    if (this.admissionLocked) {
      return this.failAck(
        'ADMISSION_LOCKED',
        'New player admission is locked by the facilitator. If you were already seated, refresh on the same browser tab to reconnect.',
      );
    }

    // If this socket already holds a seat, prevent taking a second seat
    const existingOnSocket = this.playersBySocketId.get(socketId);
    if (existingOnSocket) {
      const existingPlayer = this.players.get(existingOnSocket);
      if (existingPlayer) {
        return {
          ok: true,
          code: 'ALREADY_SEATED',
          message: `Restored Team ${existingPlayer.teamNumber} · ${existingPlayer.limbLabel}.`,
          sessionId: this.sessionId,
          stateRevision: this.stateRevision,
          inputEpoch: this.inputEpoch,
          roundId: this.roundId,
          data: this.toPrivateSeat(existingPlayer),
        };
      }
    }

    if (this.players.size >= MAX_TOTAL_PLAYERS) {
      return this.failAck(
        'SESSION_FULL',
        `All ${MAX_TOTAL_PLAYERS} classroom seats are already filled.`,
      );
    }

    const existingTeam = this.teams.get(requestedTeamNumber);
    if (existingTeam && existingTeam.seatPlayerIds.length >= this.maxTeamSize) {
      return this.failAck(
        'TEAM_FULL',
        `Team ${requestedTeamNumber} already has the maximum ${this.maxTeamSize} players. Ask the facilitator to check your team number.`,
      );
    }

    const team = this.getOrCreateDynamicTeam(requestedTeamNumber);

    const freeLimbIndex = team.seatPlayerIds.length;
    const limbLabel = `Limb ${freeLimbIndex + 1}`;
    const gestureId: GestureId =
      GESTURE_ASSIGNMENT_ORDER[(requestedTeamNumber - 1 + freeLimbIndex) % GESTURE_ASSIGNMENT_ORDER.length];
    const gestureSpec = GESTURE_SPECS[gestureId];

    const playerId = makeId('plr');
    const resumeToken = crypto.randomBytes(18).toString('hex');
    const assignment: MotionAssignment = {
      assignmentId: `asg_t${requestedTeamNumber}_l${freeLimbIndex + 1}`,
      assignmentVersion: 1,
      gestureId,
      desiredDir: { ...gestureSpec.desiredDir },
      referenceFrame: 'portrait_screen_xy',
    };

    const record: PlayerRecord = {
      playerId,
      playerName,
      resumeToken,
      teamNumber: requestedTeamNumber,
      limbIndex: freeLimbIndex,
      limbLabel,
      assignment,
      socketId,
      connected: true,
      connectionGeneration: 1,
      sensorStatus: 'unknown',
      calibrated: false,
      calibrationVersion: 0,
      minRequiredCalibrationVersion: 1,
      calibrationSummary: null,
      practiceAcceptedCount: 0,
      hasSucceededStroke: false,
      inputMethod: 'physical_sweep',
      activeAttempt: null,
      lastAcceptedAtMs: null,
      lastStrokeId: null,
      lastRecognitionResult: 'Joined; awaiting calibration',
      measuredRttMs: null,
      measuredClockOffsetMs: null,
    };

    // Atomic seat assignment + dynamic creature limb growth
    team.seatPlayerIds.push(playerId);
    team.layout = getLimbLayout(team.seatPlayerIds.length);
    this.players.set(playerId, record);
    this.playersByResumeToken.set(resumeToken, playerId);
    this.playersBySocketId.set(socketId, playerId);

    if (this.runStatus === 'ready' && (this.phase === 'straight' || this.phase === 'freewater')) {
      this.alignParticipatingStartPositions(this.phase);
    }

    this.bumpRevision();

    this.logEvent(
      'info',
      `${playerName} joined Team ${requestedTeamNumber} · ${limbLabel} (${gestureSpec.shortLabel}); creature now has ${team.layout.length} limb(s).`,
    );

    return {
      ok: true,
      code: 'JOINED',
      message: `${playerName} assigned to Team ${requestedTeamNumber} · ${limbLabel}.`,
      sessionId: this.sessionId,
      stateRevision: this.stateRevision,
      inputEpoch: this.inputEpoch,
      roundId: this.roundId,
      data: this.toPrivateSeat(record),
    };
  }

  resumePlayer(
    socketId: string,
    resumeToken: string,
  ): AckResponse<PlayerPrivateSeat> {
    if (!resumeToken || typeof resumeToken !== 'string') {
      return this.failAck('INVALID_RESUME_TOKEN', 'Invalid resume credential.');
    }

    const playerId = this.playersByResumeToken.get(resumeToken);
    if (!playerId) {
      return this.failAck(
        'SEAT_NOT_FOUND',
        'Previous seat not found in the current session. Please enter your team number to join.',
      );
    }

    const player = this.players.get(playerId);
    if (!player) {
      return this.failAck('SEAT_NOT_FOUND', 'Seat record missing.');
    }

    // Supersede any existing tab/socket holding this player identity
    const previousSocketId = player.socketId;
    if (previousSocketId && previousSocketId !== socketId) {
      this.playersBySocketId.delete(previousSocketId);
      this.callbacks.onPlayerSuperseded?.(previousSocketId);
    }

    player.socketId = socketId;
    player.connected = true;
    player.connectionGeneration += 1;
    player.activeAttempt = null;
    this.playersBySocketId.set(socketId, playerId);
    this.bumpRevision();

    this.logEvent('info', `${player.playerName} reconnected to Team ${player.teamNumber} · ${player.limbLabel} (gen ${player.connectionGeneration}).`);

    return {
      ok: true,
      code: 'RESUMED',
      message: `Restored Team ${player.teamNumber} · ${player.limbLabel}.`,
      sessionId: this.sessionId,
      stateRevision: this.stateRevision,
      inputEpoch: this.inputEpoch,
      roundId: this.roundId,
      data: this.toPrivateSeat(player),
    };
  }

  handleSocketDisconnect(socketId: string): void {
    const playerId = this.playersBySocketId.get(socketId);
    if (!playerId) return;
    this.playersBySocketId.delete(socketId);
    const player = this.players.get(playerId);
    if (!player || player.socketId !== socketId) return;

    player.socketId = null;
    player.connected = false;
    player.activeAttempt = null;
    this.bumpRevision();
    this.logEvent('info', `${player.playerName} (Team ${player.teamNumber} · ${player.limbLabel}) disconnected (seat preserved).`);
  }

  updateSensorStatus(
    socketId: string,
    payload: { sensorStatus: SensorStatus; inputMethod?: InputMethod; note?: string },
  ): AckResponse {
    const player = this.getAuthorizedPlayer(socketId);
    if (!player) return this.failAck('NOT_SEATED', 'Join a team first.');

    const validStatuses: SensorStatus[] = ['unknown', 'checking', 'ready', 'denied', 'unsupported'];
    if (!validStatuses.includes(payload.sensorStatus)) {
      return this.failAck('INVALID_SENSOR_STATUS', 'Invalid sensor status.');
    }

    player.sensorStatus = payload.sensorStatus;
    if (
      payload.inputMethod &&
      ['physical_sweep', 'tilt', 'touch_fallback'].includes(payload.inputMethod)
    ) {
      player.inputMethod = payload.inputMethod;
    }
    if (payload.note && typeof payload.note === 'string') {
      player.lastRecognitionResult = payload.note.slice(0, 120);
    }
    this.bumpRevision();
    return this.okAck('SENSOR_UPDATED', 'Sensor status recorded.');
  }

  completeCalibration(
    socketId: string,
    payload: {
      assignmentVersion: number;
      calibration: CalibrationSummary;
      inputMethod: InputMethod;
    },
  ): AckResponse<{ calibrationVersion: number }> {
    const player = this.getAuthorizedPlayer(socketId);
    if (!player) return this.failAck('NOT_SEATED', 'Join a team first.');

    if (payload.assignmentVersion !== player.assignment.assignmentVersion) {
      return this.failAck('STALE_ASSIGNMENT', 'Assignment version mismatch.');
    }

    if (!payload.calibration || typeof payload.calibration.version !== 'number') {
      return this.failAck('INVALID_CALIBRATION', 'Malformed calibration summary.');
    }

    if (!payload.calibration.validated && payload.inputMethod !== 'touch_fallback') {
      return this.failAck('CALIBRATION_UNVALIDATED', 'Hold the phone steady during calibration and try again.');
    }

    const assignedVersion = Math.max(
      player.minRequiredCalibrationVersion,
      player.calibrationVersion + 1,
      Math.floor(payload.calibration.version),
    );

    player.calibrationVersion = assignedVersion;
    player.minRequiredCalibrationVersion = assignedVersion;
    player.calibrated = true;
    player.inputMethod = payload.inputMethod;
    player.activeAttempt = null;
    player.calibrationSummary = {
      ...payload.calibration,
      version: assignedVersion,
      validated: true,
      calibratedAtServerMs: this.nowFn(),
    };
    player.lastRecognitionResult = `Calibrated (v${assignedVersion}, ${payload.inputMethod})`;
    this.bumpRevision();

    this.logEvent(
      'info',
      `Team ${player.teamNumber} · ${player.limbLabel} calibrated (v${assignedVersion}, ${payload.inputMethod}).`,
    );

    return {
      ok: true,
      code: 'CALIBRATED',
      message: 'Calibration saved.',
      sessionId: this.sessionId,
      stateRevision: this.stateRevision,
      inputEpoch: this.inputEpoch,
      roundId: this.roundId,
      data: { calibrationVersion: assignedVersion },
    };
  }

  recordConnectionProbe(
    socketId: string,
    payload: { clientSentAtMs: number; lastMeasuredRttMs?: number },
  ): { serverNowMs: number; clientSentAtMs: number } {
    const nowMs = this.nowFn();
    const player = this.getAuthorizedPlayer(socketId);
    if (player && Number.isFinite(payload.clientSentAtMs)) {
      if (
        payload.lastMeasuredRttMs != null &&
        Number.isFinite(payload.lastMeasuredRttMs) &&
        payload.lastMeasuredRttMs >= 0 &&
        payload.lastMeasuredRttMs < 10000
      ) {
        player.measuredRttMs = Math.round(payload.lastMeasuredRttMs);
        player.measuredClockOffsetMs =
          nowMs - (payload.clientSentAtMs + payload.lastMeasuredRttMs / 2);
      } else {
        player.measuredClockOffsetMs = nowMs - payload.clientSentAtMs;
      }
    }
    return { serverNowMs: nowMs, clientSentAtMs: payload.clientSentAtMs };
  }

  // =========================================================================
  // Live Input Transitions, Previews, and Authoritative Stroke Acceptance
  // =========================================================================

  handleInputBegin(socketId: string, payload: InputBeginPayload): AckResponse {
    const player = this.getAuthorizedPlayer(socketId);
    if (!player) return this.failAck('NOT_SEATED', 'Not seated.');

    const guard = this.validateEnvelope(player, payload);
    if (guard) return guard;

    if (!player.calibrated || payload.calibrationVersion !== player.calibrationVersion) {
      return this.failAck('STALE_CALIBRATION', 'Calibration is required before paddling.');
    }

    if (!this.canPreviewInput()) {
      return this.failAck('INPUT_DISABLED_IN_STATE', 'Input is currently paused or inactive.');
    }

    const nowMs = this.nowFn();
    player.inputMethod = payload.inputMethod;
    player.activeAttempt = {
      attemptId: String(payload.attemptId).slice(0, 64),
      attemptSeq: Number(payload.attemptSeq) || 0,
      startedAtServerMs: nowMs,
      lastUpdatedAtServerMs: nowMs,
      progress: 0.05,
    };
    this.bumpRevision();
    return this.okAck('ATTEMPT_OPENED', 'Input armed.');
  }

  handleInputPreview(socketId: string, payload: InputPreviewPayload): void {
    // Disposable latest-only preview update; ignored in stroke_events network mode!
    if (this.networkMode !== 'continuous') return;
    const player = this.getAuthorizedPlayer(socketId);
    if (!player || !player.calibrated) return;
    if (this.validateEnvelope(player, payload) !== null) return;
    if (!this.canPreviewInput()) return;

    const clamped = Math.max(0, Math.min(1, Number(payload.progress) || 0));
    const nowMs = this.nowFn();
    if (!player.activeAttempt || player.activeAttempt.attemptId !== payload.attemptId) {
      player.activeAttempt = {
        attemptId: String(payload.attemptId).slice(0, 64),
        attemptSeq: Number(payload.attemptSeq) || 0,
        startedAtServerMs: nowMs,
        lastUpdatedAtServerMs: nowMs,
        progress: clamped,
      };
    } else {
      player.activeAttempt.progress = clamped;
      player.activeAttempt.lastUpdatedAtServerMs = nowMs;
    }
  }

  handleInputEnd(socketId: string, payload: InputEndPayload): AckResponse {
    const player = this.getAuthorizedPlayer(socketId);
    if (!player) return this.failAck('NOT_SEATED', 'Not seated.');
    if (player.activeAttempt && player.activeAttempt.attemptId === payload.attemptId) {
      player.activeAttempt = null;
      if (payload.reason) {
        player.lastRecognitionResult = String(payload.reason).slice(0, 120);
      }
      this.bumpRevision();
    }
    return this.okAck('ATTEMPT_CLOSED', 'Input released.');
  }

  handleStrokeComplete(
    socketId: string,
    payload: StrokeCompletePayload,
  ): AckResponse<{ strokeId: string }> {
    const player = this.getAuthorizedPlayer(socketId);
    if (!player) return this.failAck('NOT_SEATED', 'Not seated.');

    if (!payload.strokeId || typeof payload.strokeId !== 'string') {
      return this.failAck('INVALID_STROKE_ID', 'Missing stroke identifier.');
    }

    // 1. Deduplicate retried stroke delivery BEFORE any side effects
    const prior = this.acceptedStrokes.get(payload.strokeId);
    if (prior) {
      return {
        ...prior,
        code: 'DUPLICATE_ALREADY_ACCEPTED',
      };
    }

    // 2. Validate session, round, inputEpoch (pause/resume barrier), and connection generation
    const envErr = this.validateEnvelope<{ strokeId: string }>(player, payload);
    if (envErr) return envErr;

    // 3. Validate calibration state and version
    if (!player.calibrated || payload.calibrationVersion !== player.calibrationVersion) {
      return this.failAck('STALE_CALIBRATION', 'Calibration changed; recalibrate before paddling.');
    }

    // 4. Validate assigned gesture
    if (payload.gestureId !== player.assignment.gestureId) {
      return this.failAck('WRONG_GESTURE_ASSIGNMENT', 'Gesture does not match your limb assignment.');
    }

    // 5. Phase & runStatus check (countdown, ready, paused, finished, lobby NEVER award propulsion or scores!)
    if (
      this.phase === 'lobby' ||
      this.runStatus !== 'running'
    ) {
      return this.failAck('ROUND_NOT_RUNNING', 'Strokes only count while the phase is actively running.');
    }

    // 6. Enforce at-most-one accepted stroke per press attemptId
    if (!payload.attemptId || this.acceptedAttemptIds.has(payload.attemptId)) {
      return this.failAck('ALREADY_SCORED_THIS_PRESS', 'Release and press again for your next stroke.');
    }

    const nowMs = this.nowFn();

    // 7. Duration & freshness window checks (prevent stalled-network backlog bursts)
    if (
      !Number.isFinite(payload.durationMs) ||
      payload.durationMs < 80 ||
      payload.durationMs > 3200
    ) {
      return this.failAck('INVALID_STROKE_DURATION', 'Stroke duration out of bounds.');
    }

    if (player.activeAttempt && player.activeAttempt.attemptId === payload.attemptId) {
      const serverOpenAgeMs = nowMs - player.activeAttempt.startedAtServerMs;
      if (serverOpenAgeMs > GAME_DEFAULTS.strokeFreshnessWindowMs + 2200) {
        player.activeAttempt = null;
        return this.failAck('EXPIRED_STROKE', 'Delayed stroke expired.');
      }
    }

    if (player.measuredClockOffsetMs !== null && Number.isFinite(payload.clientCompletedAtMs)) {
      const estimatedServerCompletedMs = payload.clientCompletedAtMs + player.measuredClockOffsetMs;
      const transitDelayMs = nowMs - estimatedServerCompletedMs;
      if (transitDelayMs > GAME_DEFAULTS.strokeFreshnessWindowMs) {
        return this.failAck('EXPIRED_STROKE', 'Delayed stroke exceeded freshness window.');
      }
    }

    // 8. Per-player scoring cadence limit (~2 strokes/sec)
    if (
      player.lastAcceptedAtMs !== null &&
      nowMs - player.lastAcceptedAtMs < GAME_DEFAULTS.minAcceptedStrokeIntervalMs
    ) {
      return this.failAck('RATE_LIMITED', 'Too fast: allow a brief return between strokes.');
    }

    // 9. Accept stroke and apply authoritative gameplay effect!
    const team = this.teams.get(player.teamNumber);
    if (!team) {
      return this.failAck('TEAM_NOT_FOUND', 'Team missing.');
    }

    this.acceptedAttemptIds.add(payload.attemptId);
    player.lastAcceptedAtMs = nowMs;
    player.lastStrokeId = payload.strokeId;
    player.inputMethod = payload.inputMethod;
    player.lastRecognitionResult = `Accepted (${Math.round(payload.durationMs)} ms)`;
    if (player.activeAttempt && player.activeAttempt.attemptId === payload.attemptId) {
      player.activeAttempt.progress = 1.0;
      player.activeAttempt.lastUpdatedAtServerMs = nowMs;
    }

    // Update training / readiness records
    if (this.phase === 'training') {
      player.practiceAcceptedCount += 1;
      player.hasSucceededStroke = true;
      team.sim.trainingPulse = Math.min(1, team.sim.trainingPulse + 0.65);
    } else {
      player.hasSucceededStroke = true;
      this.applyAcceptedStrokeImpulse(team, player);
    }

    team.latestAcknowledgment = {
      text: `${player.playerName} · ${player.limbLabel} · stroke recognized`,
      limbIndex: player.limbIndex,
      strokeId: payload.strokeId,
      atServerMs: nowMs,
    };

    this.bumpRevision();

    const ack: AckResponse<{ strokeId: string }> = {
      ok: true,
      code: 'ACCEPTED',
      message: 'Stroke accepted!',
      sessionId: this.sessionId,
      stateRevision: this.stateRevision,
      inputEpoch: this.inputEpoch,
      roundId: this.roundId,
      data: { strokeId: payload.strokeId },
    };
    this.acceptedStrokes.set(payload.strokeId, ack);

    // Keep deduplication cache bounded
    if (this.acceptedStrokes.size > 5000) {
      const oldestKey = this.acceptedStrokes.keys().next().value;
      if (oldestKey) this.acceptedStrokes.delete(oldestKey);
    }

    this.callbacks.onStrokeAccepted?.({
      strokeId: payload.strokeId,
      sessionId: this.sessionId,
      roundId: this.roundId,
      teamNumber: team.teamNumber,
      limbIndex: player.limbIndex,
      limbLabel: player.limbLabel,
      atServerMs: nowMs,
    });

    return ack;
  }

  /**
   * Fixed-impulse propulsion normalized by the creature's joined limb count N (Section 10.1 & 10.2).
   * Identical in `continuous` and `stroke_events` modes; disconnected seats NEVER shrink N or inflate power.
   */
  private applyAcceptedStrokeImpulse(team: TeamRecord, player: PlayerRecord): void {
    if (team.sim.finished || team.seatPlayerIds.length === 0) return;

    const nJoinedLimbs = team.seatPlayerIds.length; // 1..6 joined limbs — never connectedCount!
    const forwardDv = GAME_DEFAULTS.baseCycleForwardImpulse / nJoinedLimbs;

    if (this.phase === 'straight') {
      team.sim.vx = Math.min(GAME_DEFAULTS.maxLinearSpeed, team.sim.vx + forwardDv);
      return;
    }

    if (this.phase === 'freewater') {
      const cosH = Math.cos(team.sim.headingRad);
      const sinH = Math.sin(team.sim.headingRad);
      team.sim.vx += cosH * forwardDv;
      team.sim.vy += sinH * forwardDv;
      const speed = Math.hypot(team.sim.vx, team.sim.vy);
      if (speed > GAME_DEFAULTS.maxLinearSpeed) {
        const scale = GAME_DEFAULTS.maxLinearSpeed / speed;
        team.sim.vx *= scale;
        team.sim.vy *= scale;
      }

      // Bank-normalized turning: left bank turns right (+headingRad), right bank turns left (-headingRad), center_rear = 0
      const slot = team.layout[player.limbIndex];
      if (slot && (slot.bank === 'left' || slot.bank === 'right')) {
        const bankCount = team.layout.filter((l) => l.bank === slot.bank).length;
        const turnSign = slot.bank === 'left' ? 1 : -1;
        const dOmega = (turnSign * GAME_DEFAULTS.yawBankImpulse) / Math.max(1, bankCount);
        team.sim.angularVel = Math.max(
          -GAME_DEFAULTS.maxAngularSpeed,
          Math.min(GAME_DEFAULTS.maxAngularSpeed, team.sim.angularVel + dOmega),
        );
      }
    }
  }

  // =========================================================================
  // Fixed-Timestep Authoritative Pond Simulation (Section 10)
  // =========================================================================

  stepSimulation(dtMs: number): void {
    const nowMs = this.nowFn();
    const dtSec = Math.max(0, dtMs / 1000);

    // 1. Watchdog: clear abandoned holds so no limb stays stuck indefinitely
    for (const player of this.players.values()) {
      if (
        player.activeAttempt &&
        nowMs - player.activeAttempt.lastUpdatedAtServerMs > GAME_DEFAULTS.abandonedHoldTimeoutMs
      ) {
        player.activeAttempt = null;
      }
    }

    // Decay training card visual spring pulse smoothly
    if (this.phase === 'training' && this.runStatus === 'running') {
      this.activeElapsedMs += dtMs;
      for (const team of this.teams.values()) {
        if (team.sim.trainingPulse > 0) {
          team.sim.trainingPulse = Math.max(0, team.sim.trainingPulse - dtSec * 1.4);
        }
      }
      return;
    }

    // 2. Shared countdown before scored rounds
    if (this.runStatus === 'countdown') {
      this.countdownRemainingMs = Math.max(0, this.countdownRemainingMs - dtMs);
      if (this.countdownRemainingMs <= 0) {
        this.runStatus = 'running';
        this.countdownRemainingMs = 0;
        this.bumpRevision();
        this.logEvent('info', `Countdown finished; ${this.phase} round is now running.`);
        this.callbacks.onPhaseOrStatusChanged?.(this.getPublicSnapshot());
      }
      return;
    }

    if (this.runStatus !== 'running') {
      return;
    }

    // 3. Advance active simulation clock (pausing never consumes active time)
    this.activeElapsedMs += dtMs;

    if (this.phase === 'straight') {
      this.stepStraightRace(dtSec);
    } else if (this.phase === 'freewater') {
      this.stepFreewaterArena(dtSec, dtMs, nowMs);
    }
  }

  private getParticipatingTeams(): TeamRecord[] {
    return this.getSortedJoinedTeams();
  }

  private stepStraightRace(dtSec: number): void {
    const startX = 120;
    const finishX = GAME_DEFAULTS.arenaWidth - 140;
    const visualSpan = finishX - startX;

    let anyParticipating = false;
    let allParticipatingFinished = true;
    for (const team of this.teams.values()) {
      if (team.seatPlayerIds.length === 0) {
        // Unused 0-limb lobby teams do not race or block race completion
        continue;
      }
      anyParticipating = true;
      if (team.sim.finished) continue;

      team.sim.laneProgress += team.sim.vx * dtSec;
      team.sim.vx *= Math.exp(-GAME_DEFAULTS.linearDragPerSec * dtSec);
      if (team.sim.vx < 0.01) team.sim.vx = 0;

      if (team.sim.laneProgress >= GAME_DEFAULTS.straightCourseLength) {
        team.sim.laneProgress = GAME_DEFAULTS.straightCourseLength;
        team.sim.vx = 0;
        team.sim.finished = true;
        team.sim.finishTimeMs = Math.round(this.activeElapsedMs);
        team.sim.rank = this.nextFinishRank++;
        this.logEvent(
          'info',
          `Team ${team.teamNumber} finished Straight Race in ${(team.sim.finishTimeMs / 1000).toFixed(2)}s (Rank #${team.sim.rank}).`,
        );
      } else {
        allParticipatingFinished = false;
      }

      team.sim.x =
        startX +
        (team.sim.laneProgress / GAME_DEFAULTS.straightCourseLength) * visualSpan;
    }

    if ((anyParticipating && allParticipatingFinished) || this.activeElapsedMs >= this.durationSec * 1000) {
      this.finishRoundInternal(
        anyParticipating && allParticipatingFinished
          ? 'All participating teams crossed the finish line.'
          : 'Race time limit reached.',
      );
    }
  }

  private stepFreewaterArena(dtSec: number, dtMs: number, nowMs: number): void {
    const margin = GAME_DEFAULTS.creatureBodyRadius + 18;
    const minX = margin;
    const maxX = GAME_DEFAULTS.arenaWidth - margin;
    const minY = margin;
    const maxY = GAME_DEFAULTS.arenaHeight - margin;

    const participating = this.getParticipatingTeams();
    for (const team of participating) {
      team.sim.headingRad += team.sim.angularVel * dtSec;
      // Keep heading normalized to [-PI, PI]
      team.sim.headingRad = Math.atan2(Math.sin(team.sim.headingRad), Math.cos(team.sim.headingRad));
      team.sim.angularVel *= Math.exp(-GAME_DEFAULTS.angularDragPerSec * dtSec);
      if (Math.abs(team.sim.angularVel) < 0.002) team.sim.angularVel = 0;

      team.sim.x += team.sim.vx * dtSec * 4.2;
      team.sim.y += team.sim.vy * dtSec * 4.2;

      const linDecay = Math.exp(-GAME_DEFAULTS.linearDragPerSec * dtSec);
      team.sim.vx *= linDecay;
      team.sim.vy *= linDecay;

      // Soft readable wall response (no screen wrapping)
      if (team.sim.x < minX) {
        team.sim.x = minX;
        if (team.sim.vx < 0) team.sim.vx *= -0.35;
      } else if (team.sim.x > maxX) {
        team.sim.x = maxX;
        if (team.sim.vx > 0) team.sim.vx *= -0.35;
      }
      if (team.sim.y < minY) {
        team.sim.y = minY;
        if (team.sim.vy < 0) team.sim.vy *= -0.35;
      } else if (team.sim.y > maxY) {
        team.sim.y = maxY;
        if (team.sim.vy > 0) team.sim.vy *= -0.35;
      }
    }

    // Authoritative item contact & respawn (only during scored collection round)
    if (this.scoringEnabled) {
      const contactDist = GAME_DEFAULTS.creatureBodyRadius + GAME_DEFAULTS.itemCollisionRadius;

      for (const item of this.items) {
        if (!item.available) {
          if (item.respawnRemainingMs !== null) {
            item.respawnRemainingMs -= dtMs;
            if (item.respawnRemainingMs <= 0) {
              const pos = this.findFairItemPosition();
              item.x = pos.x;
              item.y = pos.y;
              item.available = true;
              item.collectedByTeam = null;
              item.collectedAtMs = null;
              item.respawnRemainingMs = null;
              this.bumpRevision();
            }
          }
          continue;
        }

        // Evaluate all contacting participating creatures in the same tick; tie-break by nearest center, then lowest teamNumber
        const contenders: Array<{ team: TeamRecord; dist: number }> = [];
        for (const team of participating) {
          if (team.seatPlayerIds.length === 0) continue;
          const dist = Math.hypot(team.sim.x - item.x, team.sim.y - item.y);
          if (dist <= contactDist) {
            contenders.push({ team, dist });
          }
        }

        if (contenders.length > 0) {
          contenders.sort((a, b) => {
            if (Math.abs(a.dist - b.dist) > 1e-6) return a.dist - b.dist;
            return a.team.teamNumber - b.team.teamNumber;
          });
          const winner = contenders[0].team;
          item.available = false;
          item.collectedByTeam = winner.teamNumber;
          item.collectedAtMs = nowMs;
          item.respawnRemainingMs = GAME_DEFAULTS.itemRespawnDelayMs;
          winner.sim.score += 1;
          this.bumpRevision();

          this.callbacks.onItemCollected?.({
            itemId: item.itemId,
            roundId: this.roundId,
            teamNumber: winner.teamNumber,
            newScore: winner.sim.score,
            x: item.x,
            y: item.y,
            atServerMs: nowMs,
          });
        }
      }
    }

    if (this.activeElapsedMs >= this.durationSec * 1000) {
      this.finishRoundInternal(
        this.scoringEnabled
          ? 'Free-water collection round complete.'
          : 'Free-water steering practice complete.',
      );
    }
  }

  private finishRoundInternal(reason: string): void {
    if (this.runStatus === 'finished') return;
    this.runStatus = 'finished';
    this.pausedForDiscussion = false;
    this.bumpInputEpoch();

    const competing = this.getParticipatingTeams();

    if (this.phase === 'straight') {
      // Finishers already received ranks 1..k by finishTimeMs.
      // Rank unfinished participating teams afterward by laneProgress descending (shared rank on exact tie).
      const unfinished = competing
        .filter((t) => !t.sim.finished)
        .sort((a, b) => {
          if (Math.abs(b.sim.laneProgress - a.sim.laneProgress) > 1e-6) {
            return b.sim.laneProgress - a.sim.laneProgress;
          }
          return a.teamNumber - b.teamNumber;
        });

      let currentRank = this.nextFinishRank;
      for (let i = 0; i < unfinished.length; i++) {
        if (
          i > 0 &&
          Math.abs(unfinished[i].sim.laneProgress - unfinished[i - 1].sim.laneProgress) <= 1e-6
        ) {
          unfinished[i].sim.rank = unfinished[i - 1].sim.rank;
        } else {
          unfinished[i].sim.rank = currentRank;
        }
        currentRank += 1;
      }
    } else if (this.phase === 'freewater' && this.scoringEnabled) {
      // Standard competition ranking by score descending among participating teams; equal scores share rank!
      const sorted = [...competing].sort((a, b) => {
        if (b.sim.score !== a.sim.score) return b.sim.score - a.sim.score;
        return a.teamNumber - b.teamNumber;
      });
      for (let i = 0; i < sorted.length; i++) {
        if (i > 0 && sorted[i].sim.score === sorted[i - 1].sim.score) {
          sorted[i].sim.rank = sorted[i - 1].sim.rank;
        } else {
          sorted[i].sim.rank = i + 1;
        }
      }
    }

    this.bumpRevision();
    this.logEvent('info', reason);
    this.callbacks.onPhaseOrStatusChanged?.(this.getPublicSnapshot());
  }

  // =========================================================================
  // Authenticated Facilitator Commands & Scoped Resets (Sections 4 & 9)
  // =========================================================================

  executeHostCommand(cmd: HostCommandPayload): AckResponse {
    if (!cmd || !cmd.commandId || typeof cmd.commandId !== 'string') {
      return this.failAck('INVALID_COMMAND', 'Missing commandId.');
    }

    // Deduplicate acknowledged retry commands
    const cached = this.processedHostCommands.get(cmd.commandId);
    if (cached) {
      return { ...cached, code: 'DUPLICATE_COMMAND_IGNORED' };
    }

    const result = this.dispatchHostCommand(cmd);
    if (result.ok) {
      this.processedHostCommands.set(cmd.commandId, result);
      if (this.processedHostCommands.size > 500) {
        const first = this.processedHostCommands.keys().next().value;
        if (first) this.processedHostCommands.delete(first);
      }
    }
    return result;
  }

  private isActiveScoredRoundRunning(): boolean {
    const isScored =
      this.phase === 'straight' || (this.phase === 'freewater' && this.scoringEnabled);
    return isScored && (this.runStatus === 'running' || this.runStatus === 'countdown');
  }

  private dispatchHostCommand(cmd: HostCommandPayload): AckResponse {
    switch (cmd.type) {
      case 'set_team_size_bounds': {
        if (this.isActiveScoredRoundRunning()) {
          return this.failAck(
            'ACTIVE_SCORED_ROUND',
            'Pause or finish the active scored round before changing team size bounds.',
          );
        }
        const minS = Number(cmd.minTeamSize);
        const maxS = Number(cmd.maxTeamSize);
        if (
          !Number.isInteger(minS) ||
          !Number.isInteger(maxS) ||
          minS < MIN_TEAM_SIZE_LIMIT ||
          maxS > MAX_TEAM_SIZE_LIMIT ||
          minS > maxS
        ) {
          return this.failAck(
            'INVALID_TEAM_SIZE_BOUNDS',
            `Team size bounds must be whole numbers between ${MIN_TEAM_SIZE_LIMIT} and ${MAX_TEAM_SIZE_LIMIT} with min <= max.`,
          );
        }

        for (const team of this.getSortedJoinedTeams()) {
          if (team.seatPlayerIds.length > maxS) {
            return this.failAck(
              'EXCEEDS_EXISTING_TEAM_SIZE',
              `Cannot lower max team size to ${maxS}: Team ${team.teamNumber} already has ${team.seatPlayerIds.length} joined players.`,
            );
          }
        }

        this.minTeamSize = minS;
        this.maxTeamSize = maxS;
        this.bumpRevision();
        this.logEvent(
          'info',
          `Set universal team size bounds to ${this.minTeamSize}–${this.maxTeamSize} players per creature.`,
        );
        return this.okAck(
          'TEAM_BOUNDS_UPDATED',
          `Universal team size range set to ${this.minTeamSize}–${this.maxTeamSize} players.`,
        );
      }

      case 'set_admission_lock': {
        this.admissionLocked = Boolean(cmd.locked);
        this.bumpRevision();
        this.logEvent('info', `New player admission ${this.admissionLocked ? 'locked' : 'unlocked'}.`);
        return this.okAck(
          'ADMISSION_UPDATED',
          this.admissionLocked ? 'New player admission locked.' : 'New player admission open.',
        );
      }

      case 'set_guide_visible': {
        const visible = Boolean(cmd.visible);
        if (visible && (this.runStatus === 'running' || this.runStatus === 'countdown')) {
          return this.failAck(
            'MUST_PAUSE_OR_STAGE_FIRST',
            'Pause or end the running phase before covering the classroom display with the guide.',
          );
        }
        this.guideVisible = visible;
        this.bumpRevision();
        this.logEvent('info', `How-to-play guide ${visible ? 'shown on' : 'hidden from'} the classroom display.`);
        return this.okAck(
          'GUIDE_UPDATED',
          visible ? 'Guide is showing on the classroom display.' : 'Guide hidden from the classroom display.',
        );
      }

      case 'set_network_mode': {
        if (this.runStatus !== 'ready' && this.runStatus !== 'paused' && this.runStatus !== 'finished') {
          return this.failAck(
            'MUST_PAUSE_OR_STAGE_FIRST',
            'Pause or stage the round before switching network presentation mode.',
          );
        }
        if (cmd.networkMode !== 'continuous' && cmd.networkMode !== 'stroke_events') {
          return this.failAck('INVALID_NETWORK_MODE', 'Unknown network mode.');
        }
        this.networkMode = cmd.networkMode;
        this.networkModeVersion += 1;
        this.bumpInputEpoch();
        this.bumpRevision();
        this.logEvent('info', `Switched network presentation mode to ${cmd.networkMode}.`);
        return this.okAck('NETWORK_MODE_CHANGED', `Network mode set to ${cmd.networkMode}.`);
      }

      case 'set_round_duration': {
        if (this.runStatus !== 'ready' && this.runStatus !== 'paused') {
          return this.failAck(
            'MUST_PAUSE_OR_STAGE_FIRST',
            'Round duration can only be edited while staged (ready) or paused.',
          );
        }
        const dur = Math.round(Number(cmd.durationSec));
        if (!Number.isFinite(dur) || dur < 10 || dur > 600) {
          return this.failAck('INVALID_DURATION', 'Duration must be between 10 and 600 seconds.');
        }
        this.durationSec = dur;
        this.bumpRevision();
        this.logEvent('info', `Set round duration to ${dur}s.`);
        return this.okAck('DURATION_UPDATED', `Duration updated to ${dur}s.`);
      }

      case 'load_phase': {
        if (this.isActiveScoredRoundRunning()) {
          return this.failAck(
            'ACTIVE_SCORED_ROUND',
            'Pause or end the active scored round before loading another phase.',
          );
        }
        this.stagePhaseInternal(
          cmd.phase,
          cmd.scoringEnabled ?? (cmd.phase === 'straight'),
          cmd.durationSec,
          cmd.seed,
        );
        this.callbacks.onPhaseOrStatusChanged?.(this.getPublicSnapshot());
        return this.okAck('PHASE_STAGED', `Staged ${cmd.phase} in ready state.`);
      }

      case 'start_phase': {
        if (this.phase === 'lobby') {
          return this.failAck('IN_LOBBY', 'Load Training, Straight Race, or Free Water before starting.');
        }
        if (this.runStatus !== 'ready') {
          return this.failAck('NOT_STAGED_READY', 'Phase must be staged in ready state to start.');
        }

        const warnings = this.computeReadinessWarnings();
        const isScored =
          this.phase === 'straight' || (this.phase === 'freewater' && this.scoringEnabled);

        if (isScored && this.players.size === 0) {
          return this.failAck(
            'NO_PLAYERS_JOINED',
            'At least one team must join before starting a scored round.',
          );
        }

        if (isScored && warnings.length > 0 && !cmd.overrideWarnings) {
          return {
            ok: false,
            code: 'READINESS_WARNING_CONFIRM_REQUIRED',
            message: `Readiness warnings present (${warnings.length}). Confirm override to start anyway.`,
            sessionId: this.sessionId,
            stateRevision: this.stateRevision,
            inputEpoch: this.inputEpoch,
            roundId: this.roundId,
          };
        }

        if (isScored && warnings.length > 0 && cmd.overrideWarnings) {
          this.logEvent(
            'warn',
            `Facilitator overrode readiness warnings to start ${this.phase}: ${warnings.join(' | ')}`,
          );
        }

        if (this.phase === 'straight' || this.phase === 'freewater') {
          this.alignParticipatingStartPositions(this.phase);
          if (this.phase === 'freewater' && this.scoringEnabled) {
            this.spawnInitialItems();
          }
        }

        // The guide must never cover live training feedback or a race
        this.guideVisible = false;

        if (isScored) {
          this.admissionLocked = true;
          this.runStatus = 'countdown';
          this.countdownRemainingMs = GAME_DEFAULTS.countdownDurationMs;
          this.logEvent('info', `Started 3s countdown for scored ${this.phase} round.`);
        } else {
          this.runStatus = 'running';
          this.countdownRemainingMs = 0;
          this.logEvent(
            'info',
            `Started ${this.phase === 'training' ? 'Training' : 'Unscored Free-Water Practice'}.`,
          );
        }

        this.pausedForDiscussion = false;
        this.bumpInputEpoch();
        this.bumpRevision();
        this.callbacks.onPhaseOrStatusChanged?.(this.getPublicSnapshot());
        return this.okAck('PHASE_STARTED', 'Phase started.');
      }

      case 'pause_phase': {
        if (this.runStatus !== 'running' && this.runStatus !== 'countdown') {
          return this.failAck('NOT_RUNNING', 'Only an active or counting-down phase can be paused.');
        }
        this.runStatus = 'paused';
        this.countdownRemainingMs = 0;
        this.pausedForDiscussion = Boolean(cmd.forDiscussion);
        this.bumpInputEpoch();
        this.bumpRevision();
        this.logEvent(
          'info',
          cmd.forDiscussion ? 'Paused activity for classroom discussion.' : 'Paused activity.',
        );
        this.callbacks.onPhaseOrStatusChanged?.(this.getPublicSnapshot());
        return this.okAck('PHASE_PAUSED', 'Phase paused; active timer and positions frozen.');
      }

      case 'resume_phase': {
        if (this.runStatus !== 'paused') {
          return this.failAck('NOT_PAUSED', 'Phase is not paused.');
        }
        this.runStatus = 'running';
        this.pausedForDiscussion = false;
        this.guideVisible = false;
        this.bumpInputEpoch();
        this.bumpRevision();
        this.logEvent('info', `Resumed ${this.phase} (inputEpoch ${this.inputEpoch}).`);
        this.callbacks.onPhaseOrStatusChanged?.(this.getPublicSnapshot());
        return this.okAck('PHASE_RESUMED', 'Phase resumed.');
      }

      case 'end_round': {
        if (this.phase === 'lobby') {
          return this.failAck('IN_LOBBY', 'No active round in lobby.');
        }
        if (this.runStatus === 'finished') {
          return this.okAck('ALREADY_FINISHED', 'Round already finished.');
        }
        this.finishRoundInternal('Round ended by facilitator.');
        return this.okAck('ROUND_ENDED', 'Round ended.');
      }

      case 'release_player_input': {
        const player = this.players.get(cmd.playerId);
        if (!player) return this.failAck('PLAYER_NOT_FOUND', 'Player not found.');
        player.activeAttempt = null;
        this.bumpRevision();
        this.logEvent('info', `Released stuck input for Team ${player.teamNumber} · ${player.limbLabel}.`);
        return this.okAck('PLAYER_INPUT_RELEASED', `Cleared held state for Team ${player.teamNumber} · ${player.limbLabel}.`);
      }

      case 'recalibrate_player': {
        if (this.isActiveScoredRoundRunning()) {
          return this.failAck(
            'PAUSE_REQUIRED',
            'Pause the active scored round before triggering player recalibration.',
          );
        }
        const player = this.players.get(cmd.playerId);
        if (!player) return this.failAck('PLAYER_NOT_FOUND', 'Player not found.');

        player.calibrated = false;
        player.minRequiredCalibrationVersion = player.calibrationVersion + 1;
        player.activeAttempt = null;
        player.lastRecognitionResult = 'Recalibration requested by facilitator';
        this.bumpRevision();
        this.logEvent('info', `Requested recalibration for Team ${player.teamNumber} · ${player.limbLabel}.`);
        this.callbacks.onPlayerRecalibrate?.(
          player.playerId,
          player.socketId,
          player.minRequiredCalibrationVersion,
        );
        return this.okAck(
          'RECALIBRATION_REQUESTED',
          `Sent recalibration prompt to Team ${player.teamNumber} · ${player.limbLabel}.`,
        );
      }

      case 'reset_practice_team': {
        if (this.isActiveScoredRoundRunning()) {
          return this.failAck('PAUSE_REQUIRED', 'Pause the active scored round first.');
        }
        const team = this.teams.get(cmd.teamNumber);
        if (!team) return this.failAck('TEAM_NOT_FOUND', 'Team not found.');
        this.clearTeamPracticeState(team);
        this.bumpRevision();
        this.logEvent('info', `Reset practice counters for Team ${team.teamNumber}.`);
        return this.okAck('TEAM_PRACTICE_RESET', `Practice state cleared for Team ${team.teamNumber}.`);
      }

      case 'reset_practice_all': {
        if (this.isActiveScoredRoundRunning()) {
          return this.failAck('PAUSE_REQUIRED', 'Pause the active scored round first.');
        }
        for (const team of this.teams.values()) {
          this.clearTeamPracticeState(team);
        }
        this.bumpRevision();
        this.logEvent('info', 'Reset practice counters for all teams.');
        return this.okAck('ALL_PRACTICE_RESET', 'Practice state cleared for all teams.');
      }

      case 'reset_scored_round': {
        if (this.isActiveScoredRoundRunning()) {
          return this.failAck('PAUSE_REQUIRED', 'Pause the active scored round before resetting it.');
        }
        if (this.phase !== 'straight' && this.phase !== 'freewater') {
          return this.failAck('NOT_A_GAME_PHASE', 'Load Straight Race or Free Water to reset a round.');
        }
        this.stagePhaseInternal(this.phase, this.scoringEnabled, this.durationSec, cmd.seed);
        this.logEvent('info', `Reset ${this.phase} round to ready state (new roundId ${this.roundId}).`);
        this.callbacks.onPhaseOrStatusChanged?.(this.getPublicSnapshot());
        return this.okAck('ROUND_RESET', 'Round reset to staged ready state.');
      }

      case 'clear_session': {
        if (!cmd.confirmClearSession) {
          return this.failAck(
            'CONFIRMATION_REQUIRED',
            'Explicit confirmation is required before clearing all seated players and session state.',
          );
        }
        this.sessionId = makeId('sess');
        this.roundId = makeId('rnd');
        this.phase = 'lobby';
        this.runStatus = 'ready';
        this.scoringEnabled = false;
        this.pausedForDiscussion = false;
        this.admissionLocked = false;
        this.guideVisible = false;
        this.activeElapsedMs = 0;
        this.countdownRemainingMs = 0;
        this.items = [];
        this.teams.clear();
        this.players.clear();
        this.playersByResumeToken.clear();
        this.playersBySocketId.clear();
        this.acceptedStrokes.clear();
        this.acceptedAttemptIds.clear();
        this.bumpInputEpoch();
        this.bumpRevision();
        this.logEvent('warn', `Cleared entire session; created fresh session ${this.sessionId}.`);
        this.callbacks.onSessionCleared?.();
        return this.okAck('SESSION_CLEARED', 'Entire session cleared; all seats reopened.');
      }
    }

    // Payloads arrive over the wire, so an unrecognized type must be rejected rather than crash the server
    return this.failAck('UNKNOWN_COMMAND', 'Unknown facilitator command.');
  }

  private clearTeamPracticeState(team: TeamRecord): void {
    team.latestAcknowledgment = null;
    team.sim.trainingPulse = 0;
    for (const pid of team.seatPlayerIds) {
      if (!pid) continue;
      const p = this.players.get(pid);
      if (!p) continue;
      p.practiceAcceptedCount = 0;
      p.hasSucceededStroke = false;
      p.activeAttempt = null;
      p.lastStrokeId = null;
    }
  }

  private stagePhaseInternal(
    phase: 'training' | 'straight' | 'freewater',
    scoringEnabled: boolean,
    explicitDurationSec?: number,
    explicitSeed?: number,
  ): void {
    this.phase = phase;
    this.runStatus = 'ready';
    this.pausedForDiscussion = false;
    this.roundId = makeId('rnd');
    this.activeElapsedMs = 0;
    this.countdownRemainingMs = 0;
    this.nextFinishRank = 1;
    this.acceptedAttemptIds.clear();

    if (explicitSeed != null && Number.isFinite(explicitSeed)) {
      this.seed = Math.floor(explicitSeed);
    } else {
      this.seed += 1;
    }
    this.rng = createSeededRng(this.seed);

    if (phase === 'training') {
      this.scoringEnabled = false;
      this.durationSec = explicitDurationSec ?? 0;
      this.items = [];
    } else if (phase === 'straight') {
      this.scoringEnabled = true;
      this.durationSec = explicitDurationSec ?? GAME_DEFAULTS.straightRaceDurationSec;
      this.items = [];
    } else {
      this.scoringEnabled = scoringEnabled;
      this.durationSec =
        explicitDurationSec ??
        (scoringEnabled
          ? GAME_DEFAULTS.freewaterScoredDurationSec
          : GAME_DEFAULTS.freewaterPracticeDurationSec);
    }

    this.alignParticipatingStartPositions(phase);

    if (phase === 'freewater' && this.scoringEnabled) {
      this.spawnInitialItems();
    } else {
      this.items = [];
    }

    this.bumpInputEpoch();
    this.bumpRevision();
    this.logEvent(
      'info',
      `Staged phase ${phase} (${this.scoringEnabled ? 'scored' : 'unscored'}, round ${this.roundId}).`,
    );
  }

  private alignParticipatingStartPositions(phase: ActivityPhase): void {
    const participating = this.getSortedJoinedTeams();
    participating.forEach((team, idx) => {
      team.latestAcknowledgment = null;
      team.sim = this.createInitialTeamSim(idx, participating.length, phase);
    });
  }

  private spawnInitialItems(): void {
    this.items = [];
    this.itemCounter = 0;
    for (let i = 0; i < GAME_DEFAULTS.targetActiveItems; i++) {
      const pos = this.findFairItemPosition(this.items);
      this.itemCounter += 1;
      this.items.push({
        itemId: `itm_${this.roundId}_${this.itemCounter}`,
        x: pos.x,
        y: pos.y,
        radius: GAME_DEFAULTS.itemCollisionRadius,
        available: true,
        variant: i % 2 === 0 ? 'golden_bug' : 'glow_seed',
        collectedByTeam: null,
        collectedAtMs: null,
        respawnRemainingMs: null,
      });
    }
  }

  private findFairItemPosition(existingItems: InternalItemRecord[] = this.items): { x: number; y: number } {
    const padX = 110;
    const padY = 95;
    const minCreatureDist =
      GAME_DEFAULTS.creatureBodyRadius + GAME_DEFAULTS.itemCollisionRadius + 48;
    const minItemDist = GAME_DEFAULTS.itemCollisionRadius * 3.4;

    for (let attempt = 0; attempt < 80; attempt++) {
      const x = padX + this.rng() * (GAME_DEFAULTS.arenaWidth - padX * 2);
      const y = padY + this.rng() * (GAME_DEFAULTS.arenaHeight - padY * 2);

      let collidesCreature = false;
      for (const team of this.getParticipatingTeams()) {
        if (Math.hypot(team.sim.x - x, team.sim.y - y) < minCreatureDist) {
          collidesCreature = true;
          break;
        }
      }
      if (collidesCreature) continue;

      let collidesItem = false;
      for (const it of existingItems) {
        if (it.available && Math.hypot(it.x - x, it.y - y) < minItemDist) {
          collidesItem = true;
          break;
        }
      }
      if (!collidesItem) {
        return { x: Math.round(x), y: Math.round(y) };
      }
    }

    return {
      x: Math.round(GAME_DEFAULTS.arenaWidth / 2),
      y: Math.round(GAME_DEFAULTS.arenaHeight / 2),
    };
  }

  // =========================================================================
  // Sanitized Role Snapshots (Section 12.3: never leak credentials)
  // =========================================================================

  getPublicSnapshot(): SessionPublicSnapshot {
    const nowMs = this.nowFn();
    const teamsOut: TeamPublicState[] = [];

    for (const team of this.getSortedJoinedTeams()) {
      let joinedCount = 0;
      let connectedCount = 0;
      let calibratedCount = 0;
      let practicedCount = 0;

      const limbs = team.layout.map((slot) => {
        const pid = team.seatPlayerIds[slot.limbIndex];
        const p = pid ? this.players.get(pid) : undefined;
        if (p) {
          joinedCount += 1;
          if (p.connected) connectedCount += 1;
          if (p.calibrated) calibratedCount += 1;
          if (p.hasSucceededStroke) practicedCount += 1;
        }
        return {
          limbIndex: slot.limbIndex,
          limbLabel: slot.limbLabel,
          bank: slot.bank,
          assignedPlayerId: p ? p.playerId : null,
          playerName: p ? p.playerName : null,
          gestureId: p ? p.assignment.gestureId : null,
          connected: p ? p.connected : false,
          sensorStatus: p ? p.sensorStatus : ('unknown' as SensorStatus),
          calibrated: p ? p.calibrated : false,
          hasSucceededStroke: p ? p.hasSucceededStroke : false,
          practiceAcceptedCount: p ? p.practiceAcceptedCount : 0,
          inputMethod: p ? p.inputMethod : ('physical_sweep' as InputMethod),
          held: Boolean(p?.activeAttempt),
          progress: p?.activeAttempt ? p.activeAttempt.progress : 0,
          lastAcceptedAtMs: p ? p.lastAcceptedAtMs : null,
          lastStrokeId: p ? p.lastStrokeId : null,
        };
      });

      teamsOut.push({
        teamNumber: team.teamNumber,
        teamName: team.teamName,
        colorHex: team.colorHex,
        colorName: team.colorName,
        accessory: team.accessory,
        minSeats: this.minTeamSize,
        maxSeats: this.maxTeamSize,
        limbCount: limbs.length,
        isSizeValid: joinedCount >= this.minTeamSize && joinedCount <= this.maxTeamSize,
        joinedCount,
        connectedCount,
        calibratedCount,
        practicedCount,
        limbs,
        latestAcknowledgment: team.latestAcknowledgment ? { ...team.latestAcknowledgment } : null,
        sim: { ...team.sim },
      });
    }

    const totalMs = this.durationSec > 0 ? this.durationSec * 1000 : 0;
    const remainingMs =
      totalMs > 0 ? Math.max(0, Math.round(totalMs - this.activeElapsedMs)) : 0;

    const round: RoundPublicState = {
      roundId: this.roundId,
      phase: this.phase,
      scoringEnabled: this.scoringEnabled,
      runStatus: this.runStatus,
      pausedForDiscussion: this.pausedForDiscussion,
      seed: this.seed,
      durationSec: this.durationSec,
      activeElapsedMs: Math.round(this.activeElapsedMs),
      remainingMs,
      countdownRemainingMs: Math.round(this.countdownRemainingMs),
      courseLength: GAME_DEFAULTS.straightCourseLength,
      arenaWidth: GAME_DEFAULTS.arenaWidth,
      arenaHeight: GAME_DEFAULTS.arenaHeight,
      items: this.items.map((it) => ({
        itemId: it.itemId,
        x: it.x,
        y: it.y,
        radius: it.radius,
        available: it.available,
        variant: it.variant,
        collectedByTeam: it.collectedByTeam,
        collectedAtMs: it.collectedAtMs,
      })),
    };

    return {
      sessionId: this.sessionId,
      stateRevision: this.stateRevision,
      serverNowMs: nowMs,
      phase: this.phase,
      runStatus: this.runStatus,
      inputEpoch: this.inputEpoch,
      networkMode: this.networkMode,
      networkModeVersion: this.networkModeVersion,
      admissionLocked: this.admissionLocked,
      guideVisible: this.guideVisible,
      minTeamSize: this.minTeamSize,
      maxTeamSize: this.maxTeamSize,
      maxTeamNumber: MAX_TEAM_NUMBER,
      publicBaseUrl: this.publicBaseUrl,
      devSimAvailable: this.devSimAvailable,
      teams: teamsOut,
      round,
    };
  }

  getHostSnapshot(): HostPrivateSnapshot {
    const nowMs = this.nowFn();
    const session = this.getPublicSnapshot();
    const players: HostPlayerDiagnostic[] = [...this.players.values()]
      .sort((a, b) => a.teamNumber - b.teamNumber || a.limbIndex - b.limbIndex)
      .map((p) => ({
        playerId: p.playerId,
        playerName: p.playerName,
        teamNumber: p.teamNumber,
        limbIndex: p.limbIndex,
        limbLabel: p.limbLabel,
        gestureId: p.assignment.gestureId,
        gestureInstruction: GESTURE_SPECS[p.assignment.gestureId].instruction,
        connected: p.connected,
        connectionGeneration: p.connectionGeneration,
        sensorStatus: p.sensorStatus,
        calibrated: p.calibrated,
        calibrationVersion: p.calibrationVersion,
        practiceAcceptedCount: p.practiceAcceptedCount,
        hasSucceededStroke: p.hasSucceededStroke,
        inputMethod: p.inputMethod,
        held: Boolean(p.activeAttempt),
        lastRecognitionResult: p.lastRecognitionResult,
        lastAcceptedStrokeAgeMs:
          p.lastAcceptedAtMs !== null ? Math.max(0, nowMs - p.lastAcceptedAtMs) : null,
        measuredRttMs: p.measuredRttMs,
      }));

    return {
      session,
      players,
      eventLog: [...this.eventLog],
      readinessWarnings: this.computeReadinessWarnings(),
    };
  }

  computeReadinessWarnings(): string[] {
    const warnings: string[] = [];
    if (this.players.size === 0) {
      warnings.push('No players have joined any team yet.');
      return warnings;
    }

    const methodsUsed = new Set<InputMethod>();
    for (const team of this.getSortedJoinedTeams()) {
      let joined = 0;
      let disconnected = 0;
      let uncalibrated = 0;
      for (const pid of team.seatPlayerIds) {
        const p = this.players.get(pid);
        if (!p) continue;
        joined += 1;
        methodsUsed.add(p.inputMethod);
        if (!p.connected) disconnected += 1;
        if (!p.calibrated) uncalibrated += 1;
      }
      if (joined < this.minTeamSize) {
        warnings.push(
          `Team ${team.teamNumber} has ${joined} joined player(s), below the minimum team size of ${this.minTeamSize}.`,
        );
      }
      if (disconnected > 0) {
        warnings.push(`Team ${team.teamNumber} has ${disconnected} disconnected player(s).`);
      }
      if (uncalibrated > 0) {
        warnings.push(`Team ${team.teamNumber} has ${uncalibrated} uncalibrated player(s).`);
      }
      if (this.phase === 'freewater' && joined === 1) {
        warnings.push(
          `Team ${team.teamNumber} has 1 joined player (center-rear tail only; add a 2nd player for left/right steering).`,
        );
      }
    }

    if (methodsUsed.size > 1) {
      warnings.push(
        `Mixed input methods active across players (${[...methodsUsed].join(', ')}); valid for classroom play, not a controlled sensor comparison.`,
      );
    }

    return warnings;
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  private getAuthorizedPlayer(socketId: string): PlayerRecord | null {
    const pid = this.playersBySocketId.get(socketId);
    if (!pid) return null;
    const player = this.players.get(pid);
    if (!player || player.socketId !== socketId) return null;
    return player;
  }

  private canPreviewInput(): boolean {
    if (this.phase === 'lobby') return false;
    return this.runStatus === 'running' || this.runStatus === 'countdown';
  }

  private validateEnvelope<T = undefined>(
    player: PlayerRecord,
    env: {
      sessionId: string;
      roundId: string;
      inputEpoch: number;
      connectionGeneration: number;
    },
  ): AckResponse<T> | null {
    if (env.sessionId !== this.sessionId) {
      return this.failAck('STALE_SESSION', 'Session changed; refresh state.');
    }
    if (env.roundId !== this.roundId) {
      return this.failAck('STALE_ROUND', 'Round changed; press again.');
    }
    if (env.inputEpoch !== this.inputEpoch) {
      return this.failAck('STALE_INPUT_EPOCH', 'Input epoch changed after pause/reset; press again.');
    }
    if (env.connectionGeneration !== player.connectionGeneration) {
      return this.failAck('STALE_CONNECTION_GEN', 'Connection generation superseded.');
    }
    return null;
  }

  private toPrivateSeat(p: PlayerRecord): PlayerPrivateSeat {
    const team = this.teams.get(p.teamNumber)!;
    return {
      playerId: p.playerId,
      playerName: p.playerName,
      resumeToken: p.resumeToken,
      sessionId: this.sessionId,
      teamNumber: p.teamNumber,
      teamName: team.teamName,
      colorHex: team.colorHex,
      accessory: team.accessory,
      maxSeats: this.maxTeamSize,
      limbIndex: p.limbIndex,
      limbLabel: p.limbLabel,
      assignment: {
        ...p.assignment,
        desiredDir: { ...p.assignment.desiredDir },
      },
      connectionGeneration: p.connectionGeneration,
      calibrationVersion: p.calibrationVersion,
      calibrated: p.calibrated,
      inputMethod: p.inputMethod,
    };
  }

  private okAck(code: string, message: string): AckResponse {
    return {
      ok: true,
      code,
      message,
      sessionId: this.sessionId,
      stateRevision: this.stateRevision,
      inputEpoch: this.inputEpoch,
      roundId: this.roundId,
    };
  }

  private failAck<T = undefined>(code: string, message: string): AckResponse<T> {
    return {
      ok: false,
      code,
      message,
      sessionId: this.sessionId,
      stateRevision: this.stateRevision,
      inputEpoch: this.inputEpoch,
      roundId: this.roundId,
    };
  }
}
