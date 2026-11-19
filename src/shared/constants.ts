import type {
  ActivityPhase,
  SectionId,
  DiscussionTopic,
  GestureId,
  GestureSpec,
  LimbSlotSpec,
  PondItemVariant,
  TeamPublicState,
} from './types.js';

export const MAX_TOTAL_PLAYERS = 30;
export const MIN_TEAM_SIZE_LIMIT = 1;
export const MAX_TEAM_SIZE_LIMIT = 6;
/** Maximum valid facilitator-assigned team number accepted on join */
export const MAX_TEAM_NUMBER = 15;

const INV_SQRT2 = Math.SQRT1_2;

export const GESTURE_SPECS: Record<GestureId, GestureSpec> = {
  left_to_right: {
    id: 'left_to_right',
    instruction: 'Sweep left to right',
    shortLabel: 'Left → Right',
    desiredDir: { x: 1, y: 0 },
  },
  right_to_left: {
    id: 'right_to_left',
    instruction: 'Sweep right to left',
    shortLabel: 'Right → Left',
    desiredDir: { x: -1, y: 0 },
  },
  top_to_bottom: {
    id: 'top_to_bottom',
    instruction: 'Sweep downward',
    shortLabel: 'Top → Bottom',
    desiredDir: { x: 0, y: -1 },
  },
  bottom_to_top: {
    id: 'bottom_to_top',
    instruction: 'Sweep upward',
    shortLabel: 'Bottom → Top',
    desiredDir: { x: 0, y: 1 },
  },
  upper_left_to_lower_right: {
    id: 'upper_left_to_lower_right',
    instruction: 'Sweep diagonally down and right',
    shortLabel: 'Upper-Left ↘ Lower-Right',
    desiredDir: { x: INV_SQRT2, y: -INV_SQRT2 },
  },
  upper_right_to_lower_left: {
    id: 'upper_right_to_lower_left',
    instruction: 'Sweep diagonally down and left',
    shortLabel: 'Upper-Right ↙ Lower-Left',
    desiredDir: { x: -INV_SQRT2, y: -INV_SQRT2 },
  },
};

/**
 * The gesture vocabulary, in the order the how-to-play guide shows it.
 * Assignment is random: the server shuffles this list once per team and hands limb i the i-th
 * entry, so a gesture is deliberately decoupled from team number, join order, and whether the
 * paddle sits on the left or right bank of the creature.
 */
export const GESTURE_ASSIGNMENT_ORDER: GestureId[] = [
  'left_to_right',
  'top_to_bottom',
  'upper_left_to_lower_right',
  'right_to_left',
  'upper_right_to_lower_left',
  'bottom_to_top',
];

export interface TeamIdentityPreset {
  teamNumber: number;
  teamName: string;
  colorHex: string;
  colorName: string;
  accessory: TeamPublicState['accessory'];
}

export const TEAM_IDENTITY_PRESETS: TeamIdentityPreset[] = [
  {
    teamNumber: 1,
    teamName: 'Sunburst Sprouts',
    colorHex: '#e06d2b',
    colorName: 'Marigold',
    accessory: 'lily_crown',
  },
  {
    teamNumber: 2,
    teamName: 'Cobalt Cattails',
    colorHex: '#2c7be5',
    colorName: 'Cobalt',
    accessory: 'reed_hat',
  },
  {
    teamNumber: 3,
    teamName: 'Berry Blossoms',
    colorHex: '#c93b76',
    colorName: 'Mulberry',
    accessory: 'sun_blossom',
  },
  {
    teamNumber: 4,
    teamName: 'Moss Acorners',
    colorHex: '#5c9e31',
    colorName: 'Meadow',
    accessory: 'acorn_beret',
  },
  {
    teamNumber: 5,
    teamName: 'Plum Ripplers',
    colorHex: '#7e4ce0',
    colorName: 'Violet',
    accessory: 'clover_crest',
  },
  {
    teamNumber: 6,
    teamName: 'Amber Tadpoles',
    colorHex: '#d49b1a',
    colorName: 'Amber',
    accessory: 'star_shell',
  },
  {
    teamNumber: 7,
    teamName: 'Coral Reedlings',
    colorHex: '#d94848',
    colorName: 'Coral',
    accessory: 'cattail_band',
  },
  {
    teamNumber: 8,
    teamName: 'Teal Waterstriders',
    colorHex: '#159a9c',
    colorName: 'Lagoon',
    accessory: 'lily_crown',
  },
  {
    teamNumber: 9,
    teamName: 'Tangerine Newts',
    colorHex: '#ef7b45',
    colorName: 'Tangerine',
    accessory: 'reed_hat',
  },
  {
    teamNumber: 10,
    teamName: 'Indigo Dragonflies',
    colorHex: '#4f5bd5',
    colorName: 'Indigo',
    accessory: 'sun_blossom',
  },
  {
    teamNumber: 11,
    teamName: 'Olive Bullfrogs',
    colorHex: '#779628',
    colorName: 'Olive',
    accessory: 'acorn_beret',
  },
  {
    teamNumber: 12,
    teamName: 'Magenta Lotus',
    colorHex: '#b8338a',
    colorName: 'Lotus',
    accessory: 'star_shell',
  },
];

export function getTeamIdentityPreset(teamNumber: number): TeamIdentityPreset {
  const idx = Math.max(0, teamNumber - 1) % TEAM_IDENTITY_PRESETS.length;
  const base = TEAM_IDENTITY_PRESETS[idx];
  return {
    ...base,
    teamNumber,
  };
}

/**
 * Dynamic modular limb layouts determined by how many players have joined the creature (0..6).
 * - Even counts (2, 4, 6) use balanced left/right paddle pairs.
 * - Odd counts (1, 3, 5) use balanced left/right paddle pairs (for >=3) plus a neutral center-rear tail paddle.
 * In local creature body space: +forward points toward the nose, +lateral points to the right side, -lateral to the left side.
 */
export function getLimbLayout(limbCount: number): LimbSlotSpec[] {
  const n = Math.max(0, Math.min(MAX_TEAM_SIZE_LIMIT, Math.floor(limbCount)));
  if (n === 0) {
    return [];
  }
  if (n === 1) {
    return [
      { limbIndex: 0, limbLabel: 'Limb 1', bank: 'center_rear', localAnchor: { forward: -1.0, lateral: 0 }, restAngleRad: Math.PI },
    ];
  }
  if (n === 2) {
    return [
      { limbIndex: 0, limbLabel: 'Limb 1', bank: 'left', localAnchor: { forward: 0.05, lateral: -0.96 }, restAngleRad: -1.48 },
      { limbIndex: 1, limbLabel: 'Limb 2', bank: 'right', localAnchor: { forward: 0.05, lateral: 0.96 }, restAngleRad: 1.48 },
    ];
  }
  if (n === 3) {
    return [
      { limbIndex: 0, limbLabel: 'Limb 1', bank: 'left', localAnchor: { forward: 0.22, lateral: -0.94 }, restAngleRad: -1.32 },
      { limbIndex: 1, limbLabel: 'Limb 2', bank: 'right', localAnchor: { forward: 0.22, lateral: 0.94 }, restAngleRad: 1.32 },
      { limbIndex: 2, limbLabel: 'Limb 3', bank: 'center_rear', localAnchor: { forward: -1.0, lateral: 0 }, restAngleRad: Math.PI },
    ];
  }
  if (n === 4) {
    return [
      { limbIndex: 0, limbLabel: 'Limb 1', bank: 'left', localAnchor: { forward: 0.42, lateral: -0.92 }, restAngleRad: -1.15 },
      { limbIndex: 1, limbLabel: 'Limb 2', bank: 'right', localAnchor: { forward: 0.42, lateral: 0.92 }, restAngleRad: 1.15 },
      { limbIndex: 2, limbLabel: 'Limb 3', bank: 'left', localAnchor: { forward: -0.38, lateral: -0.92 }, restAngleRad: -1.85 },
      { limbIndex: 3, limbLabel: 'Limb 4', bank: 'right', localAnchor: { forward: -0.38, lateral: 0.92 }, restAngleRad: 1.85 },
    ];
  }
  if (n === 5) {
    return [
      { limbIndex: 0, limbLabel: 'Limb 1', bank: 'left', localAnchor: { forward: 0.44, lateral: -0.92 }, restAngleRad: -1.12 },
      { limbIndex: 1, limbLabel: 'Limb 2', bank: 'right', localAnchor: { forward: 0.44, lateral: 0.92 }, restAngleRad: 1.12 },
      { limbIndex: 2, limbLabel: 'Limb 3', bank: 'left', localAnchor: { forward: -0.32, lateral: -0.92 }, restAngleRad: -1.82 },
      { limbIndex: 3, limbLabel: 'Limb 4', bank: 'right', localAnchor: { forward: -0.32, lateral: 0.92 }, restAngleRad: 1.82 },
      { limbIndex: 4, limbLabel: 'Limb 5', bank: 'center_rear', localAnchor: { forward: -1.0, lateral: 0 }, restAngleRad: Math.PI },
    ];
  }
  return [
    { limbIndex: 0, limbLabel: 'Limb 1', bank: 'left', localAnchor: { forward: 0.55, lateral: -0.88 }, restAngleRad: -1.0 },
    { limbIndex: 1, limbLabel: 'Limb 2', bank: 'right', localAnchor: { forward: 0.55, lateral: 0.88 }, restAngleRad: 1.0 },
    { limbIndex: 2, limbLabel: 'Limb 3', bank: 'left', localAnchor: { forward: 0.0, lateral: -0.98 }, restAngleRad: -1.52 },
    { limbIndex: 3, limbLabel: 'Limb 4', bank: 'right', localAnchor: { forward: 0.0, lateral: 0.98 }, restAngleRad: 1.52 },
    { limbIndex: 4, limbLabel: 'Limb 5', bank: 'left', localAnchor: { forward: -0.55, lateral: -0.88 }, restAngleRad: -2.04 },
    { limbIndex: 5, limbLabel: 'Limb 6', bank: 'right', localAnchor: { forward: -0.55, lateral: 0.88 }, restAngleRad: 2.04 },
  ];
}

/**
 * Provisional tunable recognition & simulation parameters (Sections 7.5 & 10).
 * Treated as configurable engineering defaults pending physical-phone validation.
 */
export const RECOGNIZER_DEFAULTS = {
  stationaryCalibrationMs: 750,
  practiceAttemptsTarget: 3,
  pressTransientIgnoreMs: 35,
  minAttemptDurationMs: 160,
  maxAttemptDurationMs: 1800,
  /** Direction tolerance in degrees around assigned screen-plane vector */
  directionToleranceDeg: 42,
  /** Minimum noise-derived onset floor in m/s^2 */
  minOnsetThresholdMps2: 1.15,
  /** Multiplier above stationary RMS noise for onset detection */
  noiseOnsetMultiplier: 4.0,
  /** Minimum peak linear acceleration in working direction (m/s^2) */
  minPeakSignalMps2: 1.75,
  /** Minimum integrated working-segment velocity impulse (m/s) for comfortable 10-20cm sweep */
  minForwardVelocityImpulseMps: 0.18,
  /** Directional consistency ratio within the initial working acceleration segment */
  minDirectionalConsistency: 0.58,
  /** Maximum pure orientation change (deg) with near-zero linear impulse before rejecting as wrist tilt */
  pureTiltRejectDeg: 28,
  /** Minimum motion sample rate diagnostic warning threshold (Hz) */
  lowSampleRateWarnHz: 20,
  /** Tilt fallback angle threshold in degrees */
  tiltFallbackThresholdDeg: 18,
} as const;

export const GAME_DEFAULTS = {
  /** Universal team size bounds (editable live on Mission Control; teams spawn dynamically as players join) */
  defaultMinTeamSize: 4,
  defaultMaxTeamSize: 6,
  countdownDurationMs: 3000,
  /** Bounds for a section's time budget when the facilitator edits it */
  minSectionBudgetSec: 10,
  maxSectionBudgetSec: 3600,
  /** Server simulation fixed timestep (60 Hz) */
  simTickMs: 1000 / 60,
  /** Public snapshot broadcast interval (~15 Hz) */
  snapshotBroadcastMs: 66,
  /** Client continuous preview cap (~16.6 Hz <= 20 Hz) */
  previewIntervalMs: 60,
  /** Per-player scoring cadence limit (~2 strokes/sec max) */
  minAcceptedStrokeIntervalMs: 480,
  /** Freshness window for stroke acceptance (ms) */
  strokeFreshnessWindowMs: 2000,
  /** Watchdog timeout to clear abandoned held states (ms) */
  abandonedHoldTimeoutMs: 2400,
  /**
   * Physics constants:
   * One full team stroke cycle (all N limbs accepting 1 stroke) adds BASE_CYCLE_FORWARD_IMPULSE in free water.
   * In the straight swim that cycle is scaled by the sync multiplier below: with drag = 1.0/s and
   * courseLength = 1000, 0.7 cycles/sec finishes in ~53s fully in sync and ~225s fully out of sync.
   */
  baseCycleForwardImpulse: 18.0,
  /**
   * Straight-swim synchrony (untested on physical phones; tune in rehearsal).
   * Strokes from different limbs of one team accepted within syncWindowMs of the first one form a sync group.
   * Must stay below minAcceptedStrokeIntervalMs so one limb cannot join the same group twice.
   */
  syncWindowMs: 350,
  /** Propulsion multiplier for a stroke nobody else joined */
  syncMinMultiplier: 0.35,
  /** Propulsion multiplier when every joined limb strokes together */
  syncMaxMultiplier: 1.5,
  straightMaxLinearSpeed: 60.0,
  /** Bank turning impulse: full left-bank cycle adds +yawBankImpulse (turns right / clockwise in screen y-down or standard heading) */
  yawBankImpulse: 1.55,
  linearDragPerSec: 1.0,
  angularDragPerSec: 2.8,
  maxLinearSpeed: 42.0,
  maxAngularSpeed: 2.6,
  straightCourseLength: 1000,
  arenaWidth: 1600,
  arenaHeight: 960,
  creatureBodyRadius: 42,
  itemCollisionRadius: 20,
  targetActiveItems: 11,
  itemRespawnDelayMs: 1000,
  /**
   * How long a disconnected player's limb stays on the creature before it is released (engineering
   * default). Long enough to ride out a page refresh or a network blip without the limb flickering.
   */
  disconnectedLimbGraceMs: 5000,
} as const;

/**
 * Open-water collectibles, common to rare (engineering defaults, untuned in a classroom).
 * `spawnWeight` is the relative chance a newly placed item is this kind; `maxActive` caps how many
 * can be in the water at once, which is what keeps the star rare.
 */
export const POND_ITEMS: Record<
  PondItemVariant,
  { label: string; points: number; spawnWeight: number; maxActive: number }
> = {
  glow_seed: { label: 'Glow Seed', points: 100, spawnWeight: 62, maxActive: Infinity },
  golden_bug: { label: 'Golden Bug', points: 300, spawnWeight: 30, maxActive: 4 },
  pond_star: { label: 'Pond Star', points: 1000, spawnWeight: 8, maxActive: 1 },
};
export const POND_ITEM_ORDER: PondItemVariant[] = ['glow_seed', 'golden_bug', 'pond_star'];

/**
 * Straight-swim propulsion multiplier for a sync group of `limbsInSync` out of `joinedLimbs`.
 * Rises linearly from syncMinMultiplier (alone) to syncMaxMultiplier (every joined limb together).
 * `joinedLimbs` is the seat count, so a disconnected teammate lowers the reachable multiplier
 * and never raises anyone's power. A one-limb creature is always fully in sync.
 */
export function getSyncMultiplier(limbsInSync: number, joinedLimbs: number): number {
  const { syncMinMultiplier: lo, syncMaxMultiplier: hi } = GAME_DEFAULTS;
  if (joinedLimbs <= 1) return hi;
  const k = Math.max(1, Math.min(joinedLimbs, limbsInSync));
  return lo + (hi - lo) * ((k - 1) / (joinedLimbs - 1));
}

/** Short facilitator- and player-facing name for a phase, shared by all three surfaces. */
export function describePhase(phase: ActivityPhase, scoringEnabled: boolean): string {
  switch (phase) {
    case 'lobby':
      return 'Lobby';
    case 'training':
      return 'Training';
    case 'straight':
      return scoringEnabled ? 'Game 1' : 'Game 1 Prep';
    case 'freewater':
      return scoringEnabled ? 'Game 2' : 'Game 2 Prep';
    case 'discussion':
      return 'Discussion';
    case 'leaderboard':
      return 'Leaderboard';
  }
}

/**
 * The session plan (owner's schedule, revision 0.5): how long each section is meant to take.
 * The section clock starts when a phase is loaded and counts down from the budget. At zero it ends
 * a scored game (Game 1, Game 2). Every other section is only paced by it: the clock turns red and
 * runs negative, and the facilitator moves on when they choose.
 * Total: 25 minutes.
 */
export const SECTION_ORDER: SectionId[] = [
  'joining',
  'training',
  'game1_prep',
  'discussion_before_game1',
  'game1',
  'discussion_after_game1',
  'game2_prep',
  'game2',
];

export const SECTION_BUDGET_DEFAULTS_SEC: Record<SectionId, number> = {
  joining: 240,
  training: 120,
  game1_prep: 180,
  discussion_before_game1: 120,
  game1: 240,
  discussion_after_game1: 120,
  game2_prep: 180,
  game2: 300,
};

export const SECTION_LABELS: Record<SectionId, string> = {
  joining: 'Explaining and Joining',
  training: 'Learning and Training',
  game1_prep: 'Game 1 Prep',
  discussion_before_game1: 'Discussion before Game 1',
  game1: 'Game 1',
  discussion_after_game1: 'Discussion after Game 1',
  game2_prep: 'Game 2 Prep',
  game2: 'Game 2',
};

/** Which section of the plan a phase belongs to. The leaderboard has no time budget. */
export function sectionForPhase(
  phase: ActivityPhase,
  scoringEnabled: boolean,
  discussionTopic: DiscussionTopic | null,
): SectionId | null {
  switch (phase) {
    case 'lobby':
      return 'joining';
    case 'training':
      return 'training';
    case 'straight':
      return scoringEnabled ? 'game1' : 'game1_prep';
    case 'freewater':
      return scoringEnabled ? 'game2' : 'game2_prep';
    case 'discussion':
      return discussionTopic === 'after_game1' ? 'discussion_after_game1' : 'discussion_before_game1';
    case 'leaderboard':
      return null;
  }
}

/** Section clock text: "3:07" while there is time left, "-0:42" once the section has overrun. */
export function formatSectionClock(remainingMs: number): string {
  const over = remainingMs < 0;
  // Count down on the ceiling (4:00 shows for a full second) and up on the floor (-0:01 after one second over)
  const totalSec = over ? Math.floor(-remainingMs / 1000) : Math.ceil(remainingMs / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${over && totalSec > 0 ? '-' : ''}${mins}:${secs.toString().padStart(2, '0')}`;
}
