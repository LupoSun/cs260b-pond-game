export type ActivityPhase = 'lobby' | 'training' | 'straight' | 'freewater';

export type RunStatus = 'ready' | 'countdown' | 'running' | 'paused' | 'finished';

export type NetworkPresentationMode = 'continuous' | 'stroke_events';

export type InputMethod = 'physical_sweep' | 'tilt' | 'touch_fallback';

export type SensorStatus = 'unknown' | 'checking' | 'ready' | 'denied' | 'unsupported';

export type GestureId =
  | 'left_to_right'
  | 'right_to_left'
  | 'top_to_bottom'
  | 'bottom_to_top'
  | 'upper_left_to_lower_right'
  | 'upper_right_to_lower_left';

export type LimbBank = 'left' | 'right' | 'center_rear';

export type TeamAccessory =
  | 'lily_crown'
  | 'reed_hat'
  | 'sun_blossom'
  | 'acorn_beret'
  | 'clover_crest'
  | 'star_shell'
  | 'cattail_band';

export interface GestureSpec {
  id: GestureId;
  instruction: string;
  shortLabel: string;
  /** Desired unit vector in portrait phone screen plane (+x right, +y up) */
  desiredDir: { x: number; y: number };
}

export interface LimbSlotSpec {
  limbIndex: number; // 0-indexed internally
  limbLabel: string; // "Limb 1" .. "Limb N"
  bank: LimbBank;
  /** Attachment offset normalized to creature body radius (forward = +x in local body frame, right = +y) */
  localAnchor: { forward: number; lateral: number };
  restAngleRad: number;
}

export interface MotionAssignment {
  assignmentId: string;
  assignmentVersion: number;
  gestureId: GestureId;
  desiredDir: { x: number; y: number };
  referenceFrame: 'portrait_screen_xy';
}

export interface CalibrationSummary {
  version: number;
  validated: boolean;
  stationaryBias: { x: number; y: number; z: number };
  stationaryNoiseRms: number;
  onsetThreshold: number;
  minPeakSignal: number;
  measuredSampleRateHz: number;
  hasLinearAcceleration: boolean;
  gravitySignConvention?: 1 | -1;
  calibratedAtServerMs?: number;
}

export type AttemptMachineState =
  | 'released'
  | 'armed'
  | 'tracking'
  | 'recognized_locked'
  | 'failed_locked';

export type RecognitionRejectionCode =
  | 'NONE'
  | 'STATIONARY_NO_MOTION'
  | 'TOO_SHORT_TAP'
  | 'TOO_LONG_HOLD'
  | 'WRONG_DIRECTION'
  | 'WEAK_SIGNAL'
  | 'LOW_DIRECTIONAL_CONSISTENCY'
  | 'ORIENTATION_TILT_ONLY'
  | 'CANCELED_INTERRUPTED'
  | 'NOT_CALIBRATED';

export interface LimbLiveState {
  limbIndex: number;
  limbLabel: string;
  bank: LimbBank;
  assignedPlayerId: string | null;
  gestureId: GestureId | null;
  connected: boolean;
  sensorStatus: SensorStatus;
  calibrated: boolean;
  hasSucceededStroke: boolean;
  practiceAcceptedCount: number;
  inputMethod: InputMethod;
  held: boolean;
  /** Normalized gesture progress [0..1], NOT physical distance in cm */
  progress: number;
  lastAcceptedAtMs: number | null;
  lastStrokeId: string | null;
}

export interface TeamSimState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Heading in radians (0 = +x right in world space) */
  headingRad: number;
  angularVel: number;
  /** Progress along straight lane [0..courseLength] */
  laneProgress: number;
  finished: boolean;
  finishTimeMs: number | null;
  rank: number | null;
  score: number;
  /** Transient spring offset in training card [0..1] */
  trainingPulse: number;
}

export interface TeamPublicState {
  teamNumber: number;
  teamName: string;
  colorHex: string;
  colorName: string;
  accessory: TeamAccessory;
  /** Universal minimum players per team configured on Mission Control */
  minSeats: number;
  /** Universal maximum players per team configured on Mission Control */
  maxSeats: number;
  /** Dynamic controllable limb count, equal to joinedCount (1..maxSeats) */
  limbCount: number;
  /** True when joinedCount is within [minSeats, maxSeats] */
  isSizeValid: boolean;
  joinedCount: number;
  connectedCount: number;
  calibratedCount: number;
  practicedCount: number;
  limbs: LimbLiveState[];
  latestAcknowledgment: {
    text: string;
    limbIndex: number;
    strokeId: string;
    atServerMs: number;
  } | null;
  sim: TeamSimState;
}

export interface PondItemPublicState {
  itemId: string;
  x: number;
  y: number;
  radius: number;
  available: boolean;
  variant: 'golden_bug' | 'glow_seed';
  collectedByTeam: number | null;
  collectedAtMs: number | null;
}

export interface RoundPublicState {
  roundId: string;
  phase: ActivityPhase;
  scoringEnabled: boolean;
  runStatus: RunStatus;
  pausedForDiscussion: boolean;
  seed: number;
  durationSec: number;
  /** Elapsed active simulation time in ms (freezes while paused) */
  activeElapsedMs: number;
  remainingMs: number;
  /** Countdown remaining ms when runStatus === 'countdown' */
  countdownRemainingMs: number;
  courseLength: number;
  arenaWidth: number;
  arenaHeight: number;
  items: PondItemPublicState[];
}

export interface SessionPublicSnapshot {
  sessionId: string;
  stateRevision: number;
  serverNowMs: number;
  phase: ActivityPhase;
  runStatus: RunStatus;
  inputEpoch: number;
  networkMode: NetworkPresentationMode;
  networkModeVersion: number;
  admissionLocked: boolean;
  minTeamSize: number;
  maxTeamSize: number;
  maxTeamNumber: number;
  publicBaseUrl: string;
  devSimAvailable: boolean;
  /** Dynamically populated teams that have >= 1 joined player, sorted by teamNumber */
  teams: TeamPublicState[];
  round: RoundPublicState;
}

export interface HostPlayerDiagnostic {
  playerId: string;
  teamNumber: number;
  limbIndex: number;
  limbLabel: string;
  gestureId: GestureId;
  gestureInstruction: string;
  connected: boolean;
  connectionGeneration: number;
  sensorStatus: SensorStatus;
  calibrated: boolean;
  calibrationVersion: number;
  practiceAcceptedCount: number;
  hasSucceededStroke: boolean;
  inputMethod: InputMethod;
  held: boolean;
  lastRecognitionResult: string;
  lastAcceptedStrokeAgeMs: number | null;
  measuredRttMs: number | null;
}

export interface SessionEventLogEntry {
  id: string;
  atIso: string;
  atServerMs: number;
  level: 'info' | 'warn';
  message: string;
}

export interface HostPrivateSnapshot {
  session: SessionPublicSnapshot;
  players: HostPlayerDiagnostic[];
  eventLog: SessionEventLogEntry[];
  readinessWarnings: string[];
}

export interface PlayerPrivateSeat {
  playerId: string;
  resumeToken: string;
  sessionId: string;
  teamNumber: number;
  teamName: string;
  colorHex: string;
  accessory: TeamPublicState['accessory'];
  maxSeats: number;
  limbIndex: number;
  limbLabel: string;
  assignment: MotionAssignment;
  connectionGeneration: number;
  calibrationVersion: number;
  calibrated: boolean;
  inputMethod: InputMethod;
}

export interface AckResponse<T = undefined> {
  ok: boolean;
  code: string;
  message: string;
  sessionId?: string;
  stateRevision?: number;
  inputEpoch?: number;
  roundId?: string;
  data?: T;
}

export interface InputBeginPayload {
  attemptId: string;
  attemptSeq: number;
  sessionId: string;
  roundId: string;
  inputEpoch: number;
  connectionGeneration: number;
  calibrationVersion: number;
  inputMethod: InputMethod;
}

export interface InputPreviewPayload {
  attemptId: string;
  attemptSeq: number;
  sessionId: string;
  roundId: string;
  inputEpoch: number;
  connectionGeneration: number;
  /** Normalized gesture progress [0..1] */
  progress: number;
}

export interface InputEndPayload {
  attemptId: string;
  attemptSeq: number;
  sessionId: string;
  roundId: string;
  inputEpoch: number;
  connectionGeneration: number;
  reason?: string;
}

export interface StrokeCompletePayload {
  strokeId: string;
  attemptId: string;
  attemptSeq: number;
  sessionId: string;
  roundId: string;
  inputEpoch: number;
  connectionGeneration: number;
  calibrationVersion: number;
  gestureId: GestureId;
  inputMethod: InputMethod;
  durationMs: number;
  clientCompletedAtMs: number;
  estimatedClockOffsetMs?: number;
}

export type HostCommandPayload =
  | {
      commandId: string;
      type: 'set_team_size_bounds';
      minTeamSize: number;
      maxTeamSize: number;
    }
  | {
      commandId: string;
      type: 'set_admission_lock';
      locked: boolean;
    }
  | {
      commandId: string;
      type: 'set_network_mode';
      networkMode: NetworkPresentationMode;
    }
  | {
      commandId: string;
      type: 'set_round_duration';
      durationSec: number;
    }
  | {
      commandId: string;
      type: 'load_phase';
      phase: 'training' | 'straight' | 'freewater';
      scoringEnabled?: boolean;
      durationSec?: number;
      seed?: number;
    }
  | {
      commandId: string;
      type: 'start_phase';
      overrideWarnings?: boolean;
    }
  | {
      commandId: string;
      type: 'pause_phase';
      forDiscussion?: boolean;
    }
  | {
      commandId: string;
      type: 'resume_phase';
    }
  | {
      commandId: string;
      type: 'end_round';
    }
  | {
      commandId: string;
      type: 'release_player_input';
      playerId: string;
    }
  | {
      commandId: string;
      type: 'recalibrate_player';
      playerId: string;
    }
  | {
      commandId: string;
      type: 'reset_practice_team';
      teamNumber: number;
    }
  | {
      commandId: string;
      type: 'reset_practice_all';
    }
  | {
      commandId: string;
      type: 'reset_scored_round';
      seed?: number;
    }
  | {
      commandId: string;
      type: 'clear_session';
      confirmClearSession: boolean;
    };

export interface StrokeAcceptedBroadcast {
  strokeId: string;
  sessionId: string;
  roundId: string;
  teamNumber: number;
  limbIndex: number;
  limbLabel: string;
  atServerMs: number;
}

export interface ItemCollectedBroadcast {
  itemId: string;
  roundId: string;
  teamNumber: number;
  newScore: number;
  x: number;
  y: number;
  atServerMs: number;
}
