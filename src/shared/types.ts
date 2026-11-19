export type ActivityPhase =
  | 'lobby'
  | 'training'
  | 'straight'
  | 'freewater'
  | 'discussion'
  | 'leaderboard';

/** Phases a facilitator can stage with `load_phase` (the lobby is only the initial state). */
export type LoadablePhase = Exclude<ActivityPhase, 'lobby'>;

/** Which prompt set a dedicated discussion phase projects. */
export type DiscussionTopic = 'before_game1' | 'after_game1';

/**
 * The timed sections of the session plan, in running order. Each has a time budget that the
 * section clock counts down from. The leaderboard has no budget and so no section.
 */
export type SectionId =
  | 'joining'
  | 'training'
  | 'game1_prep'
  | 'discussion_before_game1'
  | 'game1'
  | 'discussion_after_game1'
  | 'game2_prep'
  | 'game2';

/**
 * Clock for the section on screen, started when the phase is loaded. Reaching zero ends a scored
 * game (Game 1, Game 2) and nothing else: every other section only shows the overrun.
 * `remainingMs` keeps counting below zero so the room can see how far over it is.
 */
export interface SectionClockState {
  /** Null when the current phase has no time budget (the leaderboard) */
  section: SectionId | null;
  budgetSec: number;
  /** False while the clock is waiting to start (only the joining section waits) */
  running: boolean;
  /** Wall-clock time since the section began; not frozen by pausing a round */
  elapsedMs: number;
  /** budgetSec * 1000 - elapsedMs; negative once the section has overrun */
  remainingMs: number;
}

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
  /** Participant-chosen nickname; null for an unassigned limb */
  playerName: string | null;
  /** The player's randomly assigned emoji, shown in front of the nickname; null for an unassigned limb */
  playerEmoji: string | null;
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
  /** Free water: points from collected items (Game 2 Prep counts them too, but keeps no result) */
  score: number;
  /** Free water: how many items those points came from */
  itemsCollected: number;
  /** Transient spring offset in training card [0..1] */
  trainingPulse: number;
  /** Straight swim only: limbs that stroked together in the latest sync group (0 = none yet) */
  syncCount: number;
  /** Server time of the latest stroke that joined that sync group */
  syncAtMs: number | null;
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

/** Collectible kinds, from common to rare; point values live in POND_ITEMS (shared/constants.ts) */
export type PondItemVariant = 'glow_seed' | 'golden_bug' | 'pond_star';

export interface PondItemPublicState {
  itemId: string;
  x: number;
  y: number;
  radius: number;
  available: boolean;
  variant: PondItemVariant;
  /** Points this item is worth when collected */
  points: number;
  collectedByTeam: number | null;
  collectedAtMs: number | null;
}

export interface RoundPublicState {
  roundId: string;
  phase: ActivityPhase;
  scoringEnabled: boolean;
  runStatus: RunStatus;
  /** Prompt set shown while phase === 'discussion'; null in every other phase */
  discussionTopic: DiscussionTopic | null;
  seed: number;
  /** Elapsed active simulation time in ms (freezes while paused) */
  activeElapsedMs: number;
  /** Countdown remaining ms when runStatus === 'countdown' */
  countdownRemainingMs: number;
  courseLength: number;
  arenaWidth: number;
  arenaHeight: number;
  items: PondItemPublicState[];
}

/** One team's line in a completed scored game, frozen when that round finished. */
export interface GameTeamResult {
  teamNumber: number;
  rank: number | null;
  /** Straight race: crossed the finish line before the round ended */
  finished: boolean;
  finishTimeMs: number | null;
  /** Straight race: share of the course covered, 0..100 */
  progressPct: number;
  /** Free water: points from collected items */
  score: number;
  /** Free water: number of items collected (null in the straight race) */
  items: number | null;
  /** Accepted strokes that counted toward this round */
  strokes: number;
  /** Straight race: mean share of the team's limbs stroking together, 0..1 (null in free water or with no strokes) */
  syncAvg: number | null;
  /** Straight race: strokes where every joined limb landed together (null in free water) */
  fullSyncCount: number | null;
}

export interface GameResultPublic {
  game: 'straight' | 'freewater';
  roundId: string;
  /** Active time the round ran for */
  activeElapsedMs: number;
  /** `time_up`: the section clock reached zero, which ends the two scored games and nothing else */
  endedBy: 'all_finished' | 'time_up' | 'facilitator';
  teams: GameTeamResult[];
}

export interface LeaderboardStanding {
  teamNumber: number;
  /** Shared on equal points */
  rank: number;
  /** Placement points summed over completed games (see GAME_DEFAULTS / spec 10.5) */
  points: number;
}

/** Most recently completed scored run of each game plus the combined standings. */
export interface LeaderboardPublicState {
  straight: GameResultPublic | null;
  freewater: GameResultPublic | null;
  standings: LeaderboardStanding[];
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
  /** Facilitator-toggled how-to-play guide on the classroom display (presentation only) */
  guideVisible: boolean;
  /**
   * How much of the guide has been revealed, 1..GUIDE_STEPS.length. The facilitator steps through it
   * while explaining: the game idea first, then the three steps one by one, and the QR code last.
   */
  guideStep: number;
  /** Facilitator-toggled background music on the classroom display (presentation only, off by default) */
  musicEnabled: boolean;
  /** Background music loudness on the classroom display, 0..100 (set from Mission Control) */
  musicVolume: number;
  minTeamSize: number;
  maxTeamSize: number;
  maxTeamNumber: number;
  publicBaseUrl: string;
  devSimAvailable: boolean;
  /** Dynamically populated teams that have >= 1 joined player, sorted by teamNumber */
  teams: TeamPublicState[];
  round: RoundPublicState;
  /** Clock for the section on screen; at zero it ends a scored game and only warns everywhere else */
  sectionClock: SectionClockState;
  /** Time budget of every section, as currently set for this server run */
  sectionBudgetsSec: Record<SectionId, number>;
  leaderboard: LeaderboardPublicState;
}

export interface HostPlayerDiagnostic {
  playerId: string;
  playerName: string;
  playerEmoji: string;
  teamNumber: number;
  limbIndex: number;
  limbLabel: string;
  /**
   * False once a disconnected player's limb has been released from the creature. The identity,
   * team, gesture, and calibration are kept so the same phone can return.
   */
  seated: boolean;
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
  playerName: string;
  /** Randomly assigned at join and kept for the session, like the team and the sweep */
  playerEmoji: string;
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
      type: 'set_guide_visible';
      visible: boolean;
      /**
       * True when the facilitator loads the Explanation step: the guide starts again from its first
       * card and, in the lobby, the joining section's clock starts over. The plain show/hide toggle omits it.
       */
      fromStart?: boolean;
    }
  | {
      /** Reveals the guide up to and including this step (1..GUIDE_STEPS.length); lower hides again */
      commandId: string;
      type: 'set_guide_step';
      step: number;
    }
  | {
      commandId: string;
      type: 'set_music_enabled';
      enabled: boolean;
    }
  | {
      commandId: string;
      type: 'set_music_volume';
      /** 0..100 */
      volume: number;
    }
  | {
      commandId: string;
      type: 'set_network_mode';
      networkMode: NetworkPresentationMode;
    }
  | {
      /** Changes how long a section is planned to take. In a live scored game this moves its end. */
      commandId: string;
      type: 'set_section_budget';
      section: SectionId;
      budgetSec: number;
    }
  | {
      /** Starts the current section's clock again from its full budget */
      commandId: string;
      type: 'restart_section_clock';
    }
  | {
      commandId: string;
      type: 'load_phase';
      phase: LoadablePhase;
      /** Straight and free water only: false stages the unscored prep round */
      scoringEnabled?: boolean;
      seed?: number;
      /** Discussion only */
      discussionTopic?: DiscussionTopic;
    }
  | {
      commandId: string;
      type: 'start_phase';
      overrideWarnings?: boolean;
    }
  | {
      commandId: string;
      type: 'pause_phase';
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
  variant: PondItemVariant;
  /** Points this item added */
  points: number;
  newScore: number;
  x: number;
  y: number;
  atServerMs: number;
}
