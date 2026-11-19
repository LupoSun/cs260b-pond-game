import { GAME_DEFAULTS, getLimbLayout } from '../shared/constants.js';
import type {
  PondItemPublicState,
  PondItemVariant,
  SessionPublicSnapshot,
  TeamAccessory,
  TeamPublicState,
} from '../shared/types.js';

export interface TransientVisualEffects {
  /** Keyed by `${teamNumber}:${limbIndex}` -> local performance.now() timestamp when accepted */
  limbAcceptedFlashAtMs: Map<string, number>;
  /**
   * Collection pop bursts, keyed by award. The item's kind sets how loud the effect is:
   * a seed gets a small pop, a golden bug a bigger one, a pond star fills the arena.
   */
  itemPops: Map<
    string,
    {
      x: number;
      y: number;
      colorHex: string;
      atMs: number;
      variant?: PondItemVariant;
      points?: number;
      teamNumber?: number;
    }
  >;
}

export interface DrawCreatureOptions {
  ctx: CanvasRenderingContext2D;
  team: TeamPublicState;
  centerX: number;
  centerY: number;
  headingRad: number;
  bodyRadius: number;
  nowMs: number;
  reducedMotion: boolean;
  effects?: TransientVisualEffects;
  /** Highlight a single player's limb (used on phone controller) */
  focusLimbIndex?: number | null;
  /** Override local progress for focused limb on phone controller */
  localFocusLimbHeld?: boolean;
  localFocusLimbProgress?: number;
  showLimbLabels?: boolean;
  /** Keep limb label pills inside this box (a card, or a race lane) */
  labelBounds?: { minX: number; minY: number; maxX: number; maxY: number };
  isPaused?: boolean;
}

/* ----------------------------------------------------------------------------
   Comic ink kit: shared palette, lettering, halftone, starbursts, smoke puffs
   ---------------------------------------------------------------------------- */

const INK = '#14121f';
const PAPER = '#ffffff';
const COMIC_YELLOW = '#ffd91a';
const COMIC_RED = '#dc1f26';
const COMIC_GREEN = '#45c93a';
const COMIC_GREEN_PALE = '#a5f09b';
const COMIC_BLUE_PALE = '#9fe0ff';
const WATER_A = '#2bb1f5';
const WATER_B = '#1c9be8';
const SUCCESS_BURST = '#8dff7a';

const DISPLAY_FONT = 'Bangers, "Comic Neue", "Comic Sans MS", system-ui, sans-serif';
const BODY_FONT = '"Comic Neue", "Comic Sans MS", system-ui, -apple-system, sans-serif';

const FLASH_MS = 340;

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function hexChannels(hex: string): [number, number, number] {
  const num = parseInt(hex.replace('#', ''), 16);
  return [(num >> 16) & 0xff, (num >> 8) & 0xff, num & 0xff];
}

function shadeHex(hex: string, amount: number): string {
  const [r, g, b] = hexChannels(hex);
  return `rgb(${clampByte(r + amount)}, ${clampByte(g + amount)}, ${clampByte(b + amount)})`;
}

/** Mixes a hex color toward white (t = 1 is pure white). */
function tintHex(hex: string, t: number): string {
  const [r, g, b] = hexChannels(hex);
  return `rgb(${clampByte(r + (255 - r) * t)}, ${clampByte(g + (255 - g) * t)}, ${clampByte(b + (255 - b) * t)})`;
}

function easeOutExpo(t: number): number {
  return t >= 1 ? 1 : 1 - Math.pow(2, -10 * Math.max(0, t));
}

/** Stable pseudo-random value in [0, 1) so decorative marks never jitter between frames. */
function seeded(n: number): number {
  const v = Math.sin(n * 12.9898 + 4.1414) * 43758.5453;
  return v - Math.floor(v);
}

const halftoneCache = new WeakMap<CanvasRenderingContext2D, Map<string, CanvasPattern>>();

/** Diagonal halftone dot screen as a repeating canvas pattern (cached per context). */
function halftone(
  ctx: CanvasRenderingContext2D,
  color: string,
  spacing: number,
  dotRadius: number,
): CanvasPattern | string {
  let perCtx = halftoneCache.get(ctx);
  if (!perCtx) {
    perCtx = new Map();
    halftoneCache.set(ctx, perCtx);
  }
  const key = `${color}|${spacing}|${dotRadius}`;
  const cached = perCtx.get(key);
  if (cached) return cached;

  const scale = 3;
  const tile = document.createElement('canvas');
  tile.width = Math.round(spacing * 2 * scale);
  tile.height = tile.width;
  const tctx = tile.getContext('2d');
  if (!tctx) return 'rgba(0, 0, 0, 0)';
  tctx.fillStyle = color;
  for (const [px, py] of [
    [0.5, 0.5],
    [1.5, 1.5],
  ]) {
    tctx.beginPath();
    tctx.arc(px * spacing * scale, py * spacing * scale, dotRadius * scale, 0, Math.PI * 2);
    tctx.fill();
  }
  const pattern = ctx.createPattern(tile, 'repeat');
  if (!pattern) return 'rgba(0, 0, 0, 0)';
  if (typeof DOMMatrix !== 'undefined' && typeof pattern.setTransform === 'function') {
    pattern.setTransform(new DOMMatrix().scale(1 / scale));
  }
  perCtx.set(key, pattern);
  return pattern;
}

function burstPath(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  outerR: number,
  innerR: number,
  spikes: number,
  rotation: number,
  seed: number,
): void {
  const total = spikes * 2;
  ctx.beginPath();
  for (let i = 0; i < total; i++) {
    const rand = seeded(i + 1 + seed * 31);
    const rad = i % 2 === 0 ? outerR * (0.84 + rand * 0.16) : innerR * (0.92 + rand * 0.12);
    const a = rotation + (i / total) * Math.PI * 2;
    const px = cx + Math.cos(a) * rad;
    const py = cy + Math.sin(a) * rad;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

/** Inked comic starburst with an optional hard offset shadow. */
function drawBurst(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  outerR: number,
  innerR: number,
  spikes: number,
  rotation: number,
  seed: number,
  fill: string,
  lineW: number,
  shadowOffset = 0,
): void {
  ctx.save();
  ctx.lineJoin = 'round';
  if (shadowOffset > 0) {
    burstPath(ctx, cx + shadowOffset, cy + shadowOffset, outerR, innerR, spikes, rotation, seed);
    ctx.fillStyle = INK;
    ctx.fill();
  }
  burstPath(ctx, cx, cy, outerR, innerR, spikes, rotation, seed);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = lineW;
  ctx.stroke();
  ctx.restore();
}

/** Outlined comic lettering with an optional hard offset shadow. */
function comicText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  sizePx: number,
  fill: string,
  outlineW: number,
  shadowOffset = 0,
): void {
  ctx.save();
  ctx.font = `${Math.round(sizePx)}px ${DISPLAY_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  ctx.strokeStyle = INK;
  ctx.lineWidth = outlineW;
  if (shadowOffset > 0) {
    ctx.fillStyle = INK;
    ctx.strokeText(text, x + shadowOffset, y + shadowOffset);
    ctx.fillText(text, x + shadowOffset, y + shadowOffset);
  }
  if (outlineW > 0) ctx.strokeText(text, x, y);
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
  ctx.restore();
}

/** White smoke/splash puff: overlapping circles sharing one ink outline. */
function drawPuff(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, lineW: number): void {
  const lobes: Array<[number, number, number]> = [
    [0, 0, 1],
    [0.85, 0.12, 0.72],
    [-0.8, 0.18, 0.68],
    [0.2, -0.7, 0.66],
    [-0.3, 0.62, 0.6],
  ];
  ctx.save();
  ctx.fillStyle = INK;
  for (const [dx, dy, s] of lobes) {
    ctx.beginPath();
    ctx.arc(x + dx * r, y + dy * r, s * r + lineW, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = PAPER;
  for (const [dx, dy, s] of lobes) {
    ctx.beginPath();
    ctx.arc(x + dx * r, y + dy * r, s * r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Two-tone radial speed-line rays filling a rectangle. */
function drawRays(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  cx: number,
  cy: number,
  baseColor: string,
  rayColor: string,
  rayCount: number,
  rotation: number,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.fillStyle = baseColor;
  ctx.fillRect(x, y, w, h);
  const reach = Math.hypot(w, h);
  const step = (Math.PI * 2) / rayCount;
  ctx.fillStyle = rayColor;
  ctx.beginPath();
  for (let i = 0; i < rayCount; i++) {
    const a0 = rotation + i * step;
    const a1 = a0 + step * 0.5;
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a0) * reach, cy + Math.sin(a0) * reach);
    ctx.lineTo(cx + Math.cos(a1) * reach, cy + Math.sin(a1) * reach);
    ctx.closePath();
  }
  ctx.fill();
  ctx.restore();
}

/** Little white double-arc water marks scattered across an area. */
function drawWaveMarks(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  count: number,
  size: number,
  driftPx: number,
  seed: number,
): void {
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.62)';
  ctx.lineWidth = Math.max(1.6, size * 0.3);
  ctx.lineCap = 'round';
  for (let i = 0; i < count; i++) {
    const baseX = seeded(i * 2 + 1 + seed) * w;
    const px = x + ((((baseX - driftPx * (0.6 + seeded(i + seed) * 0.8)) % w) + w) % w);
    const py = y + (0.08 + seeded(i * 2 + 2 + seed) * 0.84) * h;
    const a0 = Math.PI * 0.18;
    const a1 = Math.PI * 0.82;
    ctx.beginPath();
    ctx.arc(px, py, size, a0, a1);
    ctx.moveTo(px + size * 2 + size * Math.cos(a0), py + size * Math.sin(a0));
    ctx.arc(px + size * 2, py, size, a0, a1);
    ctx.stroke();
  }
  ctx.restore();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/* ----------------------------------------------------------------------------
   Training / lobby card backdrop
   ---------------------------------------------------------------------------- */

/**
 * Comic panel backdrop for a team card: team-tinted speed-line rays in the corners and a
 * wobbly inked pond in the middle that the creature paddles in.
 */
export function drawCardBackdrop(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  teamColorHex: string,
  teamNumber: number,
  nowMs: number,
  reducedMotion: boolean,
): void {
  const rotation = reducedMotion ? teamNumber * 0.4 : teamNumber * 0.4 + nowMs / 14000;
  drawRays(
    ctx,
    0,
    0,
    w,
    h,
    w * 0.5,
    h * 0.5,
    tintHex(teamColorHex, 0.62),
    tintHex(teamColorHex, 0.38),
    18,
    rotation,
  );
  ctx.fillStyle = halftone(ctx, 'rgba(255, 255, 255, 0.5)', 6, 1.5);
  ctx.fillRect(0, 0, w, h);

  // Wobbly hand-inked pond blob
  const rx = w * 0.5 - 7;
  const ry = h * 0.5 - 6;
  const segs = 56;
  const pondPath = () => {
    ctx.beginPath();
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const wob =
        1 + 0.022 * Math.sin(a * 3 + teamNumber) + 0.016 * Math.sin(a * 7 + teamNumber * 2.3);
      const px = w * 0.5 + Math.cos(a) * rx * wob * 0.97;
      const py = h * 0.5 + Math.sin(a) * ry * wob * 0.97;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
  };

  ctx.save();
  pondPath();
  ctx.fillStyle = WATER_A;
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.fillStyle = halftone(ctx, 'rgba(255, 255, 255, 0.2)', 7, 1.7);
  ctx.fillRect(0, 0, w, h);
  drawWaveMarks(
    ctx,
    w * 0.1,
    h * 0.1,
    w * 0.8,
    h * 0.8,
    Math.max(3, Math.round((w * h) / 9000)),
    Math.max(3.5, Math.min(7, h * 0.03)),
    reducedMotion ? 0 : nowMs * 0.006,
    teamNumber * 17,
  );
  ctx.restore();
  // The current path is not part of the saved state, so rebuild the pond outline before inking it
  pondPath();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.restore();
}

/* ----------------------------------------------------------------------------
   Creature
   ---------------------------------------------------------------------------- */

/** Limb label pill sized for a bare limb number; name pills are placed relative to it. */
const NUMBER_PILL_W = 23;
const NUMBER_PILL_H = 19;

const fittedLabelCache = new Map<string, { text: string; width: number }>();

/**
 * Shortens a limb label with an ellipsis until it fits `maxWidth` in the context's current font.
 * Cached because the same few names are measured on every animation frame.
 */
function fitLabelText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): { text: string; width: number } {
  const key = `${ctx.font}|${Math.round(maxWidth)}|${text}`;
  const hit = fittedLabelCache.get(key);
  if (hit) return hit;

  let fitted = text;
  let width = ctx.measureText(fitted).width;
  if (width > maxWidth) {
    const points = Array.from(text);
    while (points.length > 1 && width > maxWidth) {
      points.pop();
      fitted = `${points.join('').trimEnd()}…`;
      width = ctx.measureText(fitted).width;
    }
  }
  if (fittedLabelCache.size > 600) fittedLabelCache.clear();
  const result = { text: fitted, width };
  fittedLabelCache.set(key, result);
  return result;
}

/** Distance from a w×h box's center to its edge along the unit direction (ux, uy). */
function boxReach(halfW: number, halfH: number, ux: number, uy: number): number {
  const alongX = Math.abs(ux) > 1e-6 ? halfW / Math.abs(ux) : Infinity;
  const alongY = Math.abs(uy) > 1e-6 ? halfH / Math.abs(uy) : Infinity;
  return Math.min(alongX, alongY);
}

/**
 * Renders the modular comic pond-bulb creature with all 8 specification layers (Section 11.2):
 * 1. Hard offset water shadow
 * 2. Speed lines behind a moving creature (or during a training nudge)
 * 3. Independently articulated side paddles (with defined pivot & stroke progress)
 * 4. Optional center-rear fan paddle
 * 5. Localized limb recognition highlight (~340ms green starburst + splash droplets)
 * 6. Inked, cel-shaded body with halftone shadow and an expressive face
 * 7. Non-color-only team accessory + team number badge
 * 8. Upright, rotation-invariant limb name pills + persistent readiness checkmarks
 *
 * Note: Procedural comic vector artwork used for engineering release; documented in asset inventory.
 */
export function drawModularCreature(opts: DrawCreatureOptions): void {
  const {
    ctx,
    team,
    centerX,
    centerY,
    headingRad,
    bodyRadius,
    nowMs,
    reducedMotion,
    effects,
    focusLimbIndex = null,
    localFocusLimbHeld,
    localFocusLimbProgress,
    showLimbLabels = true,
    labelBounds,
    isPaused = false,
  } = opts;

  const layout = getLimbLayout(team.limbs.length);
  const cosH = Math.cos(headingRad);
  const sinH = Math.sin(headingRad);
  const r = bodyRadius;
  const inkW = Math.max(2.4, r * 0.085);

  const speed = Math.hypot(team.sim.vx, team.sim.vy);
  const trainingPulse = team.sim.trainingPulse ?? 0;

  // Layer 1: Flat, hard-edged comic shadow offset beneath the creature
  ctx.save();
  ctx.translate(centerX + r * 0.14, centerY + r * 0.2);
  ctx.rotate(headingRad);
  ctx.fillStyle = 'rgba(20, 18, 31, 0.3)';
  ctx.beginPath();
  ctx.ellipse(0, 0, r * 1.1, r * 1.0, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Layer 2: Speed lines streaking behind a moving creature (or during a training nudge)
  if (!reducedMotion && !isPaused && (speed > 1.2 || trainingPulse > 0.08)) {
    const intensity = Math.min(1, speed / 24 + trainingPulse * 0.8);
    ctx.save();
    ctx.translate(centerX, centerY);
    ctx.rotate(headingRad);
    ctx.lineCap = 'round';
    const lanes = [-0.74, -0.3, 0.14, 0.58];
    lanes.forEach((lat, k) => {
      const phase = (nowMs / 300 + k * 0.29) % 1;
      const x0 = -r * (1.3 + phase * 0.85);
      const len = r * (0.4 + 0.55 * intensity) * (1 - phase * 0.45);
      ctx.globalAlpha = (1 - phase) * (0.4 + 0.6 * intensity);
      ctx.strokeStyle = INK;
      ctx.lineWidth = inkW * 1.35;
      ctx.beginPath();
      ctx.moveTo(x0, lat * r);
      ctx.lineTo(x0 - len, lat * r);
      ctx.stroke();
      ctx.strokeStyle = PAPER;
      ctx.lineWidth = inkW * 0.6;
      ctx.beginPath();
      ctx.moveTo(x0, lat * r);
      ctx.lineTo(x0 - len, lat * r);
      ctx.stroke();
    });
    ctx.restore();
  }

  // Precompute world anchor positions for Layer 8 upright Limb-ID pills
  const limbWorldLabelAnchors: Array<{
    limbIndex: number;
    x: number;
    y: number;
    held: boolean;
    acceptedAgeMs: number | null;
    calibrated: boolean;
    connected: boolean;
    hasSucceeded: boolean;
    assigned: boolean;
    playerName: string | null;
    playerEmoji: string | null;
  }> = [];

  let strokeBoost = 0;
  let anyFlash = false;
  let anyHeld = false;

  // Layers 3, 4 & 5: Independently animated leaf paddles + localized recognition burst
  ctx.save();
  ctx.translate(centerX, centerY);
  ctx.rotate(headingRad);
  ctx.lineJoin = 'round';

  for (const slot of layout) {
    const limbState = team.limbs[slot.limbIndex];
    const isFocus = focusLimbIndex === slot.limbIndex;

    const held =
      isFocus && localFocusLimbHeld !== undefined
        ? localFocusLimbHeld
        : Boolean(limbState?.held);
    const rawProgress =
      isFocus && localFocusLimbProgress !== undefined
        ? localFocusLimbProgress
        : (limbState?.progress ?? 0);

    const flashKey = `${team.teamNumber}:${slot.limbIndex}`;
    const flashStartMs = effects?.limbAcceptedFlashAtMs.get(flashKey);
    const flashAgeMs = flashStartMs !== undefined ? nowMs - flashStartMs : null;
    const inGreenFlash = flashAgeMs !== null && flashAgeMs >= 0 && flashAgeMs <= FLASH_MS;
    if (inGreenFlash) anyFlash = true;
    if (held) anyHeld = true;

    // Event-mode / accepted-stroke visual sweep arc even when intermediate previews are off
    let visualSweep = rawProgress;
    if (!reducedMotion && flashAgeMs !== null && flashAgeMs >= 0 && flashAgeMs <= 300) {
      const u = flashAgeMs / 300;
      const strokeArc = Math.sin(Math.PI * u);
      visualSweep = Math.max(visualSweep, strokeArc);
      strokeBoost = Math.max(strokeBoost, strokeArc);
    }
    if (reducedMotion) {
      visualSweep = held ? 0.5 : 0;
    }

    // Swing angle: paddles cock slightly forward when armed, then sweep backward toward rear!
    let swingDeltaRad = 0;
    if (!isPaused) {
      if (slot.bank === 'left') {
        // Left side: rest is negative (-1.15 rad). Sweeping backward rotates more negative toward -PI
        const prep = held ? 0.22 : 0;
        swingDeltaRad = prep - visualSweep * 0.78;
      } else if (slot.bank === 'right') {
        // Right side: rest is positive (+1.15 rad). Sweeping backward rotates more positive toward +PI
        const prep = held ? -0.22 : 0;
        swingDeltaRad = prep + visualSweep * 0.78;
      } else {
        // Center-rear tail sculls crisply across center
        swingDeltaRad = Math.sin(visualSweep * Math.PI * 2) * 0.42;
      }
    }

    const ax = slot.localAnchor.forward * r;
    const ay = slot.localAnchor.lateral * r;
    const paddleLen = slot.bank === 'center_rear' ? r * 0.88 : r * 0.82;
    const paddleWidth = slot.bank === 'center_rear' ? r * 0.46 : r * 0.36;

    ctx.save();
    ctx.translate(ax, ay);
    ctx.rotate(slot.restAngleRad + swingDeltaRad);

    // Layer 5: Localized green starburst on server acceptance (never flashes the entire card!)
    if (inGreenFlash && flashAgeMs !== null) {
      const u = flashAgeMs / FLASH_MS;
      const grow = reducedMotion ? 1 : 0.5 + 0.5 * easeOutExpo(u * 1.6);
      drawBurst(
        ctx,
        paddleLen * 0.56,
        0,
        paddleLen * 0.98 * grow,
        paddleLen * 0.6 * grow,
        9,
        slot.limbIndex * 0.7,
        slot.limbIndex + 3,
        SUCCESS_BURST,
        inkW * 0.75,
      );

      // Splash droplets flung off the paddle tip
      if (!reducedMotion) {
        const dropR = Math.max(2.4, r * 0.075) * (1 - u * 0.35);
        for (const spread of [-0.55, 0, 0.55]) {
          const dx = paddleLen * (1.02 + u * 0.62);
          const dy = spread * paddleWidth * (1.3 + u * 1.1);
          ctx.beginPath();
          ctx.arc(dx, dy, dropR, 0, Math.PI * 2);
          ctx.fillStyle = PAPER;
          ctx.fill();
          ctx.strokeStyle = INK;
          ctx.lineWidth = Math.max(1.4, inkW * 0.5);
          ctx.stroke();
        }
      }
    } else if (held && !isPaused) {
      // Armed / actively controlled indicator: flat yellow halo behind the paddle
      ctx.beginPath();
      ctx.ellipse(paddleLen * 0.52, 0, paddleLen * 0.72, paddleWidth * 1.0, 0, 0, Math.PI * 2);
      ctx.fillStyle = COMIC_YELLOW;
      ctx.fill();
      ctx.strokeStyle = INK;
      ctx.lineWidth = inkW * 0.6;
      ctx.stroke();
    }

    // Focus ring on the participant phone's own limb (white under a dashed ink line)
    if (isFocus) {
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(paddleLen * 0.5, 0, paddleLen * 0.84, paddleWidth * 1.22, 0, 0, Math.PI * 2);
      ctx.strokeStyle = PAPER;
      ctx.lineWidth = inkW * 1.5;
      ctx.stroke();
      ctx.strokeStyle = INK;
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = inkW * 0.6;
      ctx.stroke();
      ctx.restore();
    }

    // Leaf paddle blade: flat fill, cel shadow on one half, bold ink outline and vein
    const disconnected = limbState?.assignedPlayerId !== null && !limbState?.connected;
    const leafBase = inGreenFlash
      ? '#5dff83'
      : disconnected
        ? '#b3b0bd'
        : held
          ? '#7be63f'
          : COMIC_GREEN;
    const leafDark = inGreenFlash ? '#2fd65e' : disconnected ? '#8c8997' : '#2d9a2a';

    const leafPath = () => {
      ctx.beginPath();
      ctx.moveTo(0, -paddleWidth * 0.2);
      ctx.quadraticCurveTo(paddleLen * 0.45, -paddleWidth * 0.78, paddleLen, 0);
      ctx.quadraticCurveTo(paddleLen * 0.45, paddleWidth * 0.78, 0, paddleWidth * 0.2);
      ctx.closePath();
    };

    leafPath();
    ctx.fillStyle = leafBase;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(paddleLen, 0);
    ctx.quadraticCurveTo(paddleLen * 0.45, paddleWidth * 0.78, 0, paddleWidth * 0.2);
    ctx.closePath();
    ctx.fillStyle = leafDark;
    ctx.fill();

    leafPath();
    ctx.strokeStyle = INK;
    ctx.lineWidth = inkW * 0.85;
    if (disconnected) ctx.setLineDash([5, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.lineWidth = Math.max(1.3, inkW * 0.42);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(paddleLen * 0.1, 0);
    ctx.lineTo(paddleLen * 0.8, 0);
    ctx.stroke();

    ctx.restore();

    // Compute world label coordinates just past the paddle tip so the pill never hides the leaf
    const labelReach = paddleLen * 0.92 + Math.min(11, r * 0.28);
    const tipLocalX = ax + Math.cos(slot.restAngleRad) * labelReach;
    const tipLocalY = ay + Math.sin(slot.restAngleRad) * labelReach;
    const worldX = centerX + tipLocalX * cosH - tipLocalY * sinH;
    const worldY = centerY + tipLocalX * sinH + tipLocalY * cosH;

    limbWorldLabelAnchors.push({
      limbIndex: slot.limbIndex,
      x: worldX,
      y: worldY,
      held,
      acceptedAgeMs: flashAgeMs,
      calibrated: Boolean(limbState?.calibrated),
      connected: Boolean(limbState?.connected),
      hasSucceeded: Boolean(limbState?.hasSucceededStroke),
      assigned: limbState?.assignedPlayerId !== null,
      playerName: limbState?.playerName ?? null,
      playerEmoji: limbState?.playerEmoji ?? null,
    });
  }

  // Layer 6: Chunky inked pond-bulb body with squash-and-stretch on every accepted stroke
  ctx.save();
  if (!reducedMotion && !isPaused) {
    const breathe = Math.sin(nowMs / 620 + team.teamNumber * 1.7) * 0.012;
    const kick = Math.max(strokeBoost, Math.min(1, trainingPulse) * 0.6);
    ctx.scale(1 + breathe + kick * 0.075, 1 - breathe - kick * 0.06);
  }

  const bodyPath = () => {
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 1.03, r * 0.94, 0, 0, Math.PI * 2);
  };

  // Light comes from the upper-left of the page regardless of heading
  const lightX = -0.42 * cosH - 0.82 * sinH;
  const lightY = 0.42 * sinH - 0.82 * cosH;

  bodyPath();
  ctx.fillStyle = shadeHex(team.colorHex, -58);
  ctx.fill();

  ctx.save();
  bodyPath();
  ctx.clip();
  ctx.fillStyle = halftone(ctx, 'rgba(255, 255, 255, 0.4)', r > 50 ? 6 : 4, r > 50 ? 1.6 : 1.15);
  ctx.fillRect(-r * 1.2, -r * 1.2, r * 2.4, r * 2.4);
  ctx.fillStyle = team.colorHex;
  ctx.beginPath();
  ctx.ellipse(lightX * r * 0.19, lightY * r * 0.19, r * 1.0, r * 0.9, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  bodyPath();
  ctx.strokeStyle = INK;
  ctx.lineWidth = inkW;
  ctx.stroke();

  // Flat white specular highlight toward the light
  ctx.fillStyle = 'rgba(255, 255, 255, 0.88)';
  ctx.beginPath();
  ctx.ellipse(
    lightX * r * 0.58 - r * 0.12,
    lightY * r * 0.58,
    r * 0.2,
    r * 0.095,
    Math.atan2(lightY, lightX) + Math.PI / 2,
    0,
    Math.PI * 2,
  );
  ctx.fill();

  // Expressive eyes near the front (+x in local creature coordinates)
  const excited = anyFlash || trainingPulse > 0.2;
  const eyeX = r * 0.46;
  const eyeSpreadY = r * 0.35;
  const eyeRadius = Math.max(4.5, r * (excited ? 0.225 : 0.2));
  const blinking =
    !reducedMotion && !isPaused && !excited && (nowMs + team.teamNumber * 830) % 3600 < 130;

  for (const sign of [-1, 1]) {
    const ey = sign * eyeSpreadY;
    // Rosy cheek
    ctx.fillStyle = 'rgba(255, 110, 160, 0.78)';
    ctx.beginPath();
    ctx.ellipse(
      eyeX - eyeRadius * 0.95,
      ey + sign * eyeRadius * 0.9,
      eyeRadius * 0.55,
      eyeRadius * 0.36,
      0,
      0,
      Math.PI * 2,
    );
    ctx.fill();

    ctx.strokeStyle = INK;
    ctx.lineWidth = Math.max(1.8, inkW * 0.62);
    ctx.lineCap = 'round';

    if (blinking) {
      ctx.beginPath();
      ctx.moveTo(eyeX, ey - eyeRadius * 0.8);
      ctx.lineTo(eyeX, ey + eyeRadius * 0.8);
      ctx.stroke();
      continue;
    }

    // Sclera
    ctx.fillStyle = PAPER;
    ctx.beginPath();
    ctx.arc(eyeX, ey, eyeRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Pupil + catchlight
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.arc(eyeX + eyeRadius * 0.28, ey, eyeRadius * (anyHeld ? 0.62 : 0.54), 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = PAPER;
    ctx.beginPath();
    ctx.arc(eyeX + eyeRadius * 0.46, ey - eyeRadius * 0.24, eyeRadius * 0.2, 0, Math.PI * 2);
    ctx.fill();
  }

  // Mouth: quiet smile at rest, wide open shout while a stroke is landing
  ctx.strokeStyle = INK;
  ctx.lineWidth = Math.max(1.8, inkW * 0.62);
  if (excited) {
    ctx.beginPath();
    ctx.arc(r * 0.64, 0, r * 0.19, -Math.PI / 2, Math.PI / 2);
    ctx.closePath();
    ctx.fillStyle = INK;
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#ff5a6e';
    ctx.beginPath();
    ctx.ellipse(r * 0.74, 0, r * 0.06, r * 0.1, 0, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.arc(r * 0.62, 0, r * 0.15, -0.7, 0.7);
    ctx.stroke();
  }

  // Layer 7: Distinct Team Accessory (non-color identity!)
  drawTeamAccessory(ctx, team.accessory, r, Math.max(1.8, inkW * 0.6));

  ctx.restore();
  ctx.restore();

  // Upright Team Number Medallion at creature center (readable at any heading!)
  ctx.save();
  const badgeR = Math.max(10, r * 0.35);
  ctx.fillStyle = PAPER;
  ctx.strokeStyle = INK;
  ctx.lineWidth = Math.max(2.2, inkW * 0.8);
  ctx.beginPath();
  ctx.arc(centerX, centerY, badgeR, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  comicText(ctx, String(team.teamNumber), centerX, centerY + badgeR * 0.08, badgeR * 1.45, INK, 0);
  ctx.restore();

  // Layer 8: Upright limb labels (always horizontal regardless of creature rotation!)
  // Each pill carries the player's nickname; a limb nobody holds shows its number instead.
  if (showLimbLabels) {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Names are longer than the old limb numbers, so the lettering grows with the creature
    const baseFontPx = Math.max(12, Math.min(16.5, r * 0.34));
    const maxTextW = Math.max(44, Math.min(150, r * 2.0));

    // Two teammates may pick the same nickname; the limb number then tells them apart
    const nameCounts = new Map<string, number>();
    for (const anchor of limbWorldLabelAnchors) {
      if (!anchor.playerName) continue;
      const key = anchor.playerName.toLocaleLowerCase();
      nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
    }

    const pills = limbWorldLabelAnchors.map((anchor) => {
      const isFocus = focusLimbIndex === anchor.limbIndex;
      const fontPx = isFocus ? baseFontPx + 1.5 : baseFontPx;
      const font = `700 ${fontPx}px ${BODY_FONT}`;
      ctx.font = font;

      const limbNumber = String(anchor.limbIndex + 1);
      const isShared =
        anchor.playerName !== null &&
        (nameCounts.get(anchor.playerName.toLocaleLowerCase()) ?? 0) > 1;
      const suffix = `${isShared ? ` ${limbNumber}` : ''}${anchor.hasSucceeded ? '✓' : ''}`;
      const suffixW = suffix ? ctx.measureText(suffix).width : 0;
      const fitted = fitLabelText(ctx, anchor.playerName ?? limbNumber, maxTextW - suffixW);
      // The player's emoji leads the nickname, drawn larger than the lettering and never truncated:
      // it is what the room recognises a limb by from a distance
      const emoji = anchor.playerName !== null ? anchor.playerEmoji : null;
      const emojiPx = Math.round(fontPx * 1.3);
      const emojiFont = `${emojiPx}px ${BODY_FONT}`;
      let prefixW = 0;
      if (emoji) {
        ctx.font = emojiFont;
        prefixW = ctx.measureText(emoji).width + Math.max(2, fontPx * 0.22);
        ctx.font = font;
      }

      const padX = isFocus ? 8 : 6.5;
      const minW = isFocus ? 34 : anchor.hasSucceeded ? 30 : NUMBER_PILL_W;
      const w = Math.max(minW, Math.ceil(prefixW + fitted.width + suffixW) + padX * 2);
      const h = Math.round((emoji ? Math.max(fontPx, emojiPx - 1) : fontPx) + (isFocus ? 9.5 : 7));

      // The anchor is where a bare-number pill sits. A wider pill slides outward along the
      // limb's direction so its near edge stays put and the paddle is not covered.
      let ux = anchor.x - centerX;
      let uy = anchor.y - centerY;
      const dist = Math.hypot(ux, uy) || 1;
      ux /= dist;
      uy /= dist;
      const slide = Math.max(
        0,
        boxReach(w / 2, h / 2, ux, uy) - boxReach(NUMBER_PILL_W / 2, NUMBER_PILL_H / 2, ux, uy),
      );

      return {
        anchor,
        isFocus,
        font,
        text: `${fitted.text}${suffix}`,
        emoji,
        emojiFont,
        prefixW,
        w,
        h,
        x: anchor.x + ux * slide,
        y: anchor.y + uy * slide,
      };
    });

    // Neighbouring name pills would stack on top of each other, so nudge overlapping pairs apart
    // along the line between their centers, then pull everything back inside the allowed box.
    const GAP = 3;
    for (let pass = 0; pass < 8; pass++) {
      for (let i = 0; i < pills.length; i++) {
        for (let j = i + 1; j < pills.length; j++) {
          const a = pills[i];
          const b = pills[j];
          const needX = (a.w + b.w) / 2 + GAP;
          const needY = (a.h + b.h) / 2 + GAP;
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          if (Math.abs(dx) >= needX || Math.abs(dy) >= needY) continue;
          let d = Math.hypot(dx, dy);
          if (d < 0.01) {
            dx = 1;
            dy = 0;
            d = 1;
          }
          const push = (boxReach(needX, needY, dx / d, dy / d) - d) / 2;
          a.x -= (dx / d) * push;
          a.y -= (dy / d) * push;
          b.x += (dx / d) * push;
          b.y += (dy / d) * push;
        }
      }
      if (labelBounds) {
        for (const pill of pills) {
          const loX = labelBounds.minX + pill.w / 2;
          const hiX = labelBounds.maxX - pill.w / 2;
          const loY = labelBounds.minY + pill.h / 2;
          const hiY = labelBounds.maxY - pill.h / 2;
          if (hiX >= loX) pill.x = Math.max(loX, Math.min(hiX, pill.x));
          if (hiY >= loY) pill.y = Math.max(loY, Math.min(hiY, pill.y));
        }
      }
    }

    for (const pill of pills) {
      const { anchor, isFocus, w: pillW, h: pillH } = pill;
      const inFlash =
        anchor.acceptedAgeMs !== null &&
        anchor.acceptedAgeMs >= 0 &&
        anchor.acceptedAgeMs <= FLASH_MS + 10;

      let bg = PAPER;
      let fg = INK;
      let dashed = false;

      if (inFlash) {
        bg = COMIC_GREEN;
      } else if (isFocus) {
        bg = COMIC_YELLOW;
      } else if (anchor.assigned && !anchor.connected) {
        bg = '#d8d2c2';
        fg = '#3d3a4d';
        dashed = true;
      } else if (anchor.hasSucceeded) {
        bg = COMIC_GREEN_PALE;
      } else if (anchor.calibrated && anchor.connected) {
        bg = COMIC_BLUE_PALE;
      } else if (!anchor.assigned) {
        bg = 'rgba(255, 255, 255, 0.72)';
        fg = '#3d3a4d';
        dashed = true;
      }

      // Hard offset shadow, then the pill
      roundRect(ctx, pill.x - pillW / 2 + 1.5, pill.y - pillH / 2 + 2, pillW, pillH, 7);
      ctx.fillStyle = INK;
      ctx.fill();

      roundRect(ctx, pill.x - pillW / 2, pill.y - pillH / 2, pillW, pillH, 7);
      ctx.fillStyle = bg;
      ctx.fill();
      ctx.strokeStyle = INK;
      ctx.lineWidth = isFocus ? 2.6 : 2;
      ctx.setLineDash(dashed ? [3, 2.5] : []);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = fg;
      if (pill.emoji) {
        // Emoji on the left, lettering centered in what is left of the pill
        ctx.font = pill.emojiFont;
        ctx.textAlign = 'left';
        ctx.fillText(pill.emoji, pill.x - pillW / 2 + (isFocus ? 7 : 5.5), pill.y + 1);
        ctx.textAlign = 'center';
        ctx.font = pill.font;
        ctx.fillStyle = fg;
        ctx.fillText(pill.text, pill.x + pill.prefixW / 2, pill.y + 0.5);
      } else {
        ctx.font = pill.font;
        ctx.fillText(pill.text, pill.x, pill.y + 0.5);
      }
    }
    ctx.restore();
  }
}

function drawTeamAccessory(
  ctx: CanvasRenderingContext2D,
  accessory: TeamAccessory,
  r: number,
  lineW: number,
): void {
  ctx.save();
  // Place accessory slightly behind center so center medallion & front eyes stay unobstructed
  ctx.translate(-r * 0.46, 0);
  ctx.strokeStyle = INK;
  ctx.lineWidth = lineW;
  ctx.lineJoin = 'round';

  switch (accessory) {
    case 'lily_crown': {
      ctx.fillStyle = COMIC_YELLOW;
      ctx.beginPath();
      ctx.moveTo(-r * 0.2, -r * 0.24);
      ctx.lineTo(r * 0.08, -r * 0.15);
      ctx.lineTo(-r * 0.04, 0);
      ctx.lineTo(r * 0.08, r * 0.15);
      ctx.lineTo(-r * 0.2, r * 0.24);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      break;
    }
    case 'reed_hat': {
      ctx.fillStyle = '#ffe9a8';
      ctx.beginPath();
      ctx.ellipse(-r * 0.05, 0, r * 0.22, r * 0.32, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = COMIC_RED;
      ctx.beginPath();
      ctx.ellipse(-r * 0.05, 0, r * 0.1, r * 0.15, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      break;
    }
    case 'sun_blossom': {
      ctx.fillStyle = '#ff8fc4';
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(Math.cos(a) * r * 0.14, Math.sin(a) * r * 0.14, r * 0.1, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.fillStyle = COMIC_YELLOW;
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.09, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      break;
    }
    case 'acorn_beret': {
      ctx.fillStyle = '#a8612a';
      ctx.beginPath();
      ctx.arc(-r * 0.04, 0, r * 0.22, Math.PI * 0.5, Math.PI * 1.5);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      break;
    }
    case 'clover_crest': {
      ctx.fillStyle = '#8ff07a';
      for (const dy of [-0.12, 0.12]) {
        ctx.beginPath();
        ctx.arc(-r * 0.06, dy * r, r * 0.12, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      break;
    }
    case 'star_shell': {
      ctx.fillStyle = '#fff2a0';
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2;
        const rad = i % 2 === 0 ? r * 0.24 : r * 0.11;
        if (i === 0) ctx.moveTo(Math.cos(a) * rad, Math.sin(a) * rad);
        else ctx.lineTo(Math.cos(a) * rad, Math.sin(a) * rad);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      break;
    }
    case 'cattail_band': {
      ctx.fillStyle = '#8a4a22';
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(-r * 0.12, side * r * 0.22, r * 0.15, r * 0.075, side * 0.3, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      break;
    }
  }
  ctx.restore();
}

/* ----------------------------------------------------------------------------
   Straight race
   ---------------------------------------------------------------------------- */

/**
 * Draws the full Straight Swimming Race Pond (`1600 x 960` logical space).
 */
export function drawStraightRaceScene(
  ctx: CanvasRenderingContext2D,
  snapshot: SessionPublicSnapshot,
  nowMs: number,
  reducedMotion: boolean,
  effects: TransientVisualEffects,
): void {
  const W = snapshot.round.arenaWidth;
  const H = snapshot.round.arenaHeight;

  // Start line sits clear of the lane signs so a rear paddle label never covers a team sign
  const startX = 208;
  const finishX = W - 140;
  const spanX = finishX - startX;
  const populatedTeams = snapshot.teams.filter((t) => t.joinedCount > 0);
  const raceTeams = populatedTeams.length > 0 ? populatedTeams : snapshot.teams;
  const teamCount = Math.max(1, raceTeams.length);
  const laneH = H / teamCount;
  const running = snapshot.runStatus === 'running';
  const drift = reducedMotion || !running ? 0 : nowMs * 0.05;

  // Flat two-tone comic water lanes with a halftone screen and drifting wave marks
  for (let i = 0; i < teamCount; i++) {
    ctx.fillStyle = i % 2 === 0 ? WATER_A : WATER_B;
    ctx.fillRect(0, i * laneH, W, laneH + 1);
  }
  ctx.fillStyle = halftone(ctx, 'rgba(255, 255, 255, 0.17)', 11, 2.8);
  ctx.fillRect(0, 0, W, H);
  drawWaveMarks(ctx, 0, 0, W, H, 34, 9, drift, 5);

  // Distance markers (25%, 50%, 75%)
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.lineWidth = 4;
  ctx.setLineDash([14, 14]);
  for (const pct of [0.25, 0.5, 0.75]) {
    const mx = startX + spanX * pct;
    ctx.beginPath();
    ctx.moveTo(mx, 0);
    ctx.lineTo(mx, H);
    ctx.stroke();
  }
  ctx.restore();

  // Start line: inked white band
  ctx.save();
  ctx.fillStyle = INK;
  ctx.fillRect(startX - 7, 0, 14, H);
  ctx.fillStyle = PAPER;
  ctx.fillRect(startX - 3.5, 0, 7, H);
  ctx.restore();

  // Checkered finish strip with ink rails
  ctx.save();
  const checkSize = 24;
  for (let y = 0; y < H; y += checkSize) {
    const row = Math.floor(y / checkSize);
    ctx.fillStyle = row % 2 === 0 ? PAPER : INK;
    ctx.fillRect(finishX - checkSize, y, checkSize, checkSize);
    ctx.fillStyle = row % 2 === 0 ? INK : PAPER;
    ctx.fillRect(finishX, y, checkSize, checkSize);
  }
  ctx.fillStyle = INK;
  ctx.fillRect(finishX - checkSize - 5, 0, 5, H);
  ctx.fillRect(finishX + checkSize, 0, 5, H);
  ctx.restore();

  // Lanes & Creatures
  raceTeams.forEach((team, idx) => {
    const topY = idx * laneH;
    const midY = topY + laneH / 2;

    if (idx > 0) {
      // Inked lane rope with chunky red-and-white buoys
      ctx.save();
      ctx.strokeStyle = INK;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(0, topY);
      ctx.lineTo(W, topY);
      ctx.stroke();

      let buoyIndex = 0;
      for (let bx = 150; bx < finishX - 50; bx += 96) {
        ctx.fillStyle = buoyIndex % 2 === 0 ? COMIC_RED : PAPER;
        ctx.strokeStyle = INK;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.ellipse(bx, topY, 12, 7.5, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        buoyIndex += 1;
      }
      ctx.restore();
    }

    // Left lane sign: caption box with hard shadow
    const signH = Math.min(58, laneH - 8);
    const compactSign = signH < 46;
    ctx.save();
    ctx.fillStyle = INK;
    ctx.fillRect(11, midY - signH / 2 + 4, 98, signH);
    ctx.fillStyle = PAPER;
    ctx.fillRect(7, midY - signH / 2, 98, signH);
    ctx.strokeStyle = INK;
    ctx.lineWidth = 3;
    ctx.strokeRect(7, midY - signH / 2, 98, signH);

    // Team color chip so the sign matches the creature without relying on color alone
    ctx.fillStyle = team.colorHex;
    ctx.beginPath();
    ctx.arc(21, midY - (compactSign ? 0 : 9), 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 2.2;
    ctx.stroke();

    const pctDone = Math.round((team.sim.laneProgress / snapshot.round.courseLength) * 100);
    if (compactSign) {
      comicText(ctx, `T${team.teamNumber}  ${pctDone}%`, 66, midY + 1, 17, INK, 0);
    } else {
      comicText(ctx, `TEAM ${team.teamNumber}`, 66, midY - 8, 21, INK, 0);
      ctx.fillStyle = '#3d3a4d';
      ctx.font = `700 13px ${BODY_FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${pctDone}% · ${team.limbCount}L`, 56, midY + 14);
    }
    ctx.restore();

    const drawX = startX + (team.sim.laneProgress / snapshot.round.courseLength) * spanX;
    const radius = Math.min(40, laneH * 0.27);

    drawModularCreature({
      ctx,
      team,
      centerX: drawX,
      centerY: midY,
      headingRad: 0,
      bodyRadius: radius,
      nowMs,
      reducedMotion,
      effects,
      showLimbLabels: true,
      // Name pills stay inside the team's own lane and off its lane sign
      labelBounds: { minX: 112, minY: topY + 7, maxX: W - 4, maxY: topY + laneH - 7 },
      isPaused: snapshot.runStatus === 'paused',
    });

    // Scored race only: call out how many limbs just landed together. Game 1 Prep stays silent so the
    // class can discover the rule before the "what makes you fast?" discussion.
    const syncAgeMs =
      team.sim.syncAtMs === null ? Infinity : snapshot.serverNowMs - team.sim.syncAtMs;
    if (
      snapshot.round.scoringEnabled &&
      running &&
      !team.sim.finished &&
      team.limbCount >= 2 &&
      team.sim.syncCount >= 2 &&
      syncAgeMs < 900
    ) {
      const allTogether = team.sim.syncCount >= team.limbCount;
      const label = allTogether ? 'ALL TOGETHER!' : `${team.sim.syncCount} OF ${team.limbCount} TOGETHER`;
      const size = Math.max(13, Math.min(26, laneH * 0.17)) * (allTogether ? 1.15 : 1);
      ctx.save();
      ctx.font = `${Math.round(size)}px ${DISPLAY_FONT}`;
      const halfW = ctx.measureText(label).width / 2;
      ctx.restore();
      // Open water ahead of the creature keeps the callout off its limb labels; close to the
      // finish strip it moves behind instead.
      const clearance = radius * 2.3;
      const aheadX = drawX + clearance + halfW;
      const tagX = aheadX + halfW < finishX - 40 ? aheadX : drawX - clearance - halfW;
      comicText(ctx, label, tagX, midY, size, allTogether ? COMIC_YELLOW : PAPER, 4);
    }

    // Finish starburst in lane (rank and time, never color-only)
    if (team.sim.finished && team.sim.rank !== null) {
      const finishAgeMs = snapshot.round.activeElapsedMs - (team.sim.finishTimeMs ?? 0);
      const pop = reducedMotion ? 1 : 0.4 + 0.6 * easeOutExpo(Math.max(0, finishAgeMs) / 420);
      const burstR = Math.min(54, laneH * 0.48) * pop;
      const bx = finishX + 80;
      const isWinner = team.sim.rank === 1;
      drawBurst(
        ctx,
        bx,
        midY,
        burstR,
        burstR * 0.68,
        11,
        team.teamNumber * 0.5,
        team.teamNumber,
        isWinner ? COMIC_YELLOW : PAPER,
        3,
        4,
      );
      const sec = ((team.sim.finishTimeMs ?? 0) / 1000).toFixed(1);
      comicText(ctx, `#${team.sim.rank}`, bx, midY - burstR * 0.12, burstR * 0.56, INK, 0);
      ctx.save();
      ctx.fillStyle = INK;
      ctx.font = `700 ${Math.max(10, Math.round(burstR * 0.24))}px ${BODY_FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${sec}s`, bx, midY + burstR * 0.27);
      ctx.restore();
    }
  });

  // Marker labels drawn last so creatures never hide them
  for (const pct of [0.25, 0.5, 0.75]) {
    comicText(ctx, `${Math.round(pct * 100)}%`, startX + spanX * pct, 20, 24, PAPER, 5);
  }
  comicText(ctx, 'FINISH', finishX, 20, 24, COMIC_YELLOW, 5);
}

/* ----------------------------------------------------------------------------
   Free water
   ---------------------------------------------------------------------------- */

/**
 * Draws the shared Free-Water Steering & Item Collection Pond (`1600 x 960` logical space).
 */
export function drawFreewaterScene(
  ctx: CanvasRenderingContext2D,
  snapshot: SessionPublicSnapshot,
  nowMs: number,
  reducedMotion: boolean,
  effects: TransientVisualEffects,
): void {
  const W = snapshot.round.arenaWidth;
  const H = snapshot.round.arenaHeight;
  const running = snapshot.runStatus === 'running';

  // Two-tone radial speed-line water with a halftone screen
  drawRays(ctx, 0, 0, W, H, W / 2, H / 2, WATER_A, WATER_B, 28, 0.08);
  ctx.fillStyle = halftone(ctx, 'rgba(255, 255, 255, 0.17)', 11, 2.8);
  ctx.fillRect(0, 0, W, H);
  drawWaveMarks(ctx, 60, 60, W - 120, H - 120, 30, 9, reducedMotion || !running ? 0 : nowMs * 0.012, 11);

  // Arena boundary rope (decorative lily pads strictly outside active boundary!)
  const margin = GAME_DEFAULTS.creatureBodyRadius + 18;
  ctx.save();
  roundRect(ctx, margin - 18, margin - 18, W - (margin - 18) * 2, H - (margin - 18) * 2, 36);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 9;
  ctx.stroke();
  ctx.strokeStyle = PAPER;
  ctx.lineWidth = 3.5;
  ctx.setLineDash([22, 16]);
  ctx.stroke();
  ctx.setLineDash([]);

  // Edge lily pads at corners (never obstructing gameplay footprints)
  const cornerPads = [
    { x: 36, y: 36, r: 30, a: 0.25 },
    { x: W - 38, y: 40, r: 28, a: 2.1 },
    { x: 42, y: H - 38, r: 29, a: 4.2 },
    { x: W - 36, y: H - 36, r: 31, a: 3.3 },
  ];
  for (const pad of cornerPads) {
    ctx.fillStyle = COMIC_GREEN;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 3.5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.arc(pad.x, pad.y, pad.r, pad.a, pad.a + Math.PI * 1.7);
    ctx.lineTo(pad.x, pad.y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#2d9a2a';
    ctx.beginPath();
    ctx.arc(pad.x, pad.y, pad.r - 2, pad.a + Math.PI * 0.85, pad.a + Math.PI * 1.7);
    ctx.lineTo(pad.x, pad.y);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();

  // Collectible Pond Items (2D collision footprint exact match)
  for (const item of snapshot.round.items) {
    if (!item.available) continue;
    drawPondCollectible(ctx, item, nowMs, reducedMotion);
  }

  // Draw participating team creatures (overlap permitted; no inter-creature collision)
  const populatedTeams = snapshot.teams.filter((t) => t.joinedCount > 0);
  const arenaTeams = populatedTeams.length > 0 ? populatedTeams : snapshot.teams;
  for (const team of arenaTeams) {
    drawModularCreature({
      ctx,
      team,
      centerX: team.sim.x,
      centerY: team.sim.y,
      headingRad: team.sim.headingRad,
      bodyRadius: GAME_DEFAULTS.creatureBodyRadius,
      nowMs,
      reducedMotion,
      effects,
      showLimbLabels: true,
      isPaused: snapshot.runStatus === 'paused',
    });
  }

  // Transient item collection callouts, scaled to what was caught:
  //   glow seed  -> small starburst and "+100"
  //   golden bug -> bigger spinning burst, more smoke, "NICE!"
  //   pond star  -> arena-wide flash, shockwave ring, double burst, "JACKPOT!"
  const arenaW = snapshot.round.arenaWidth;
  const arenaH = snapshot.round.arenaHeight;
  for (const [id, pop] of effects.itemPops.entries()) {
    const tier = pop.variant === 'pond_star' ? 2 : pop.variant === 'golden_bug' ? 1 : 0;
    const popMs = [640, 980, 1750][tier];
    const size = [1, 1.45, 2.3][tier];
    const age = nowMs - pop.atMs;
    if (age > popMs) {
      effects.itemPops.delete(id);
      continue;
    }
    const u = Math.max(0, age / popMs);
    const grow = reducedMotion ? 1 : 0.35 + 0.65 * easeOutExpo(u * (tier === 2 ? 3.2 : 1.8));
    const fade = u > 0.72 ? Math.max(0, 1 - (u - 0.72) / 0.28) : 1;
    // Keep the lettering of a big pop on screen even when the item sat near a wall
    const margin = 84 * size;
    const px = Math.max(margin, Math.min(arenaW - margin, pop.x));
    const py = Math.max(margin, Math.min(arenaH - margin * 0.6, pop.y));

    ctx.save();
    if (tier === 2 && !reducedMotion) {
      // Flash, then a shockwave ring racing outward from the catch
      if (u < 0.2) {
        ctx.fillStyle = `rgba(255, 217, 26, ${0.42 * (1 - u / 0.2)})`;
        ctx.fillRect(0, 0, arenaW, arenaH);
      }
      for (const lag of [0, 0.14]) {
        const ru = u - lag;
        if (ru <= 0 || ru >= 0.7) continue;
        ctx.globalAlpha = 1 - ru / 0.7;
        ctx.strokeStyle = INK;
        ctx.lineWidth = 16 * (1 - ru / 0.7) + 3;
        ctx.beginPath();
        ctx.arc(pop.x, pop.y, 50 + ru * 900, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = COMIC_YELLOW;
        ctx.lineWidth = 9 * (1 - ru / 0.7) + 1.5;
        ctx.stroke();
      }
    }

    ctx.globalAlpha = fade;
    const spin = reducedMotion ? 0 : u * 0.9 * tier;
    if (tier === 2) {
      drawBurst(ctx, px, py, 78 * size * grow, 50 * size * grow, 16, -spin, 6, PAPER, 4, 6);
    }
    drawBurst(ctx, px, py, 58 * size * grow, 36 * size * grow, 10 + tier * 2, 0.3 + spin, 4, pop.colorHex, 3.5, 4);
    drawBurst(ctx, px, py, 42 * size * grow, 27 * size * grow, 10 + tier * 2, 0.3 - spin, 4, COMIC_YELLOW, 3);
    if (!reducedMotion) {
      const puffs = [3, 6, 10][tier];
      for (let k = 0; k < puffs; k++) {
        const a = (k / puffs) * Math.PI * 2 + 0.5;
        const reach = (40 + u * 52) * size;
        drawPuff(ctx, px + Math.cos(a) * reach, py + Math.sin(a) * reach * 0.82, 9 * size * (1 - u * 0.4), 2.2);
      }
    }
    const rise = reducedMotion ? 0 : u * 10 * size;
    const pointsText = `+${pop.points ?? 100}`;
    if (tier === 0) {
      comicText(ctx, pointsText, px, py - rise, 32 * grow, PAPER, 6, 2.5);
    } else if (tier === 1) {
      comicText(ctx, 'NICE!', px, py - 26 * grow - rise, 27 * grow, COMIC_YELLOW, 5, 2.5);
      comicText(ctx, pointsText, px, py + 12 * grow - rise, 46 * grow, PAPER, 7, 3);
    } else {
      const who = pop.teamNumber !== undefined ? `TEAM ${pop.teamNumber} ` : '';
      comicText(ctx, `${who}JACKPOT!`, px, py - 58 * grow - rise, 46 * grow, COMIC_YELLOW, 8, 4);
      comicText(ctx, pointsText, px, py + 14 * grow - rise, 96 * grow, PAPER, 10, 5);
    }
    ctx.restore();
  }
}

function drawPondCollectible(
  ctx: CanvasRenderingContext2D,
  item: PondItemPublicState,
  nowMs: number,
  reducedMotion: boolean,
): void {
  const phase = nowMs / 260 + item.x * 0.02;
  const bob = reducedMotion ? 0 : Math.sin(phase) * 2.5;
  const r = item.radius;

  ctx.save();
  ctx.translate(item.x, item.y);
  ctx.lineJoin = 'round';

  // Dashed ring showing the exact 2D contact radius
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
  ctx.lineWidth = 2.5;
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  // Hard offset shadow
  ctx.fillStyle = 'rgba(20, 18, 31, 0.3)';
  ctx.beginPath();
  ctx.ellipse(4, 7, r * 0.66, r * 0.56, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.translate(0, bob);
  // Rarer items are drawn larger; the contact ring above stays at the true collision radius
  const drawScale = item.variant === 'pond_star' ? 1.55 : item.variant === 'golden_bug' ? 1.15 : 1;
  ctx.scale(drawScale, drawScale);
  ctx.strokeStyle = INK;

  if (item.variant === 'pond_star') {
    // Slowly turning halo of rays behind the star
    const turn = reducedMotion ? 0 : nowMs / 900;
    ctx.save();
    ctx.rotate(turn);
    ctx.fillStyle = 'rgba(255, 240, 163, 0.85)';
    for (let k = 0; k < 8; k++) {
      const a0 = (k / 8) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, r * 1.28, a0, a0 + Math.PI / 8);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    // Five-point star with a cel shadow
    const pulse = reducedMotion ? 1 : 1 + 0.06 * Math.sin(phase * 2.2);
    const starPath = (outer: number, inner: number) => {
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i / 10) * Math.PI * 2;
        const rad = i % 2 === 0 ? outer : inner;
        if (i === 0) ctx.moveTo(Math.cos(a) * rad, Math.sin(a) * rad);
        else ctx.lineTo(Math.cos(a) * rad, Math.sin(a) * rad);
      }
      ctx.closePath();
    };
    ctx.fillStyle = '#e09a00';
    ctx.lineWidth = 3;
    starPath(r * 0.92 * pulse, r * 0.42 * pulse);
    ctx.fill();
    ctx.save();
    ctx.clip();
    ctx.fillStyle = COMIC_YELLOW;
    ctx.beginPath();
    ctx.arc(-r * 0.16, -r * 0.2, r * 0.78, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    starPath(r * 0.92 * pulse, r * 0.42 * pulse);
    ctx.stroke();
  } else if (item.variant === 'golden_bug') {
    // Wings
    ctx.fillStyle = PAPER;
    ctx.lineWidth = 2.4;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(side * r * 0.5, -r * 0.2, r * 0.46, r * 0.26, side * 0.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // Golden beetle shell with a cel shadow and ink stripe
    ctx.fillStyle = '#e09a00';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.64, 0, Math.PI * 2);
    ctx.fill();
    ctx.save();
    ctx.clip();
    ctx.fillStyle = COMIC_YELLOW;
    ctx.beginPath();
    ctx.arc(-r * 0.12, -r * 0.14, r * 0.62, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.64, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -r * 0.62);
    ctx.lineTo(0, r * 0.62);
    ctx.stroke();
  } else {
    // Glowing pond seed pod with a cel shadow
    ctx.fillStyle = '#58b800';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 0.58, r * 0.74, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.save();
    ctx.clip();
    ctx.fillStyle = '#c4f53a';
    ctx.beginPath();
    ctx.ellipse(-r * 0.12, -r * 0.14, r * 0.55, r * 0.7, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 0.58, r * 0.74, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Flat white highlight
  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.beginPath();
  ctx.ellipse(-r * 0.24, -r * 0.3, r * 0.14, r * 0.08, -0.6, 0, Math.PI * 2);
  ctx.fill();

  // Four-point comic sparkle that twinkles beside the item
  const twinkle = reducedMotion ? 1 : 0.65 + 0.35 * Math.sin(phase * 1.7);
  const sx = r * 0.78;
  const sy = -r * 0.72;
  const sr = r * 0.3 * twinkle;
  ctx.fillStyle = PAPER;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const rad = i % 2 === 0 ? sr : sr * 0.34;
    if (i === 0) ctx.moveTo(sx + Math.cos(a) * rad, sy + Math.sin(a) * rad);
    else ctx.lineTo(sx + Math.cos(a) * rad, sy + Math.sin(a) * rad);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.restore();

  // Point value under the items worth more than the common seed, so teams can see what to chase
  if (item.variant !== 'glow_seed') {
    const big = item.variant === 'pond_star';
    comicText(ctx, String(item.points), item.x, item.y + r * drawScale + (big ? 17 : 13), big ? 23 : 16, big ? COMIC_YELLOW : PAPER, big ? 5 : 4, big ? 2 : 0);
  }
}
