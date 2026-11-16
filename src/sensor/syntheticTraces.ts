import { GESTURE_SPECS } from '../shared/constants.js';
import type { GestureId } from '../shared/types.js';
import { computeW3CGravityReaction } from './gravity.js';
import type { MotionSample } from './types.js';

export interface SyntheticSweepOptions {
  startTimestampMs: number;
  sampleRateHz?: number;
  durationMs?: number;
  peakAccelMps2?: number;
  /** Angle offset in degrees added to the gesture's desired direction (e.g. 180 for opposite sweep) */
  angleOffsetDeg?: number;
  includeLinearSensor?: boolean;
  betaDeg?: number;
  gammaDeg?: number;
  noiseStdMps2?: number;
  seed?: number;
}

function createSeededNoise(seed = 42): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    const u1 = Math.max(1e-6, (s & 0xffff) / 0x10000);
    s = (s * 1664525 + 1013904223) >>> 0;
    const u2 = (s & 0xffff) / 0x10000;
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };
}

export function generateStationarySamples(
  startTimestampMs: number,
  durationMs = 800,
  sampleRateHz = 60,
  includeLinearSensor = true,
  betaDeg = 55,
  gammaDeg = 3,
  noiseStdMps2 = 0.06,
): MotionSample[] {
  const dtMs = 1000 / sampleRateHz;
  const count = Math.max(2, Math.floor(durationMs / dtMs));
  const randn = createSeededNoise(101);
  const gVec = computeW3CGravityReaction(betaDeg, gammaDeg, 1);
  const samples: MotionSample[] = [];

  for (let i = 0; i < count; i++) {
    const nx = randn() * noiseStdMps2;
    const ny = randn() * noiseStdMps2;
    const nz = randn() * noiseStdMps2;
    samples.push({
      timestampMs: startTimestampMs + i * dtMs,
      linearAccel: includeLinearSensor ? { x: 0.03 + nx, y: -0.02 + ny, z: 0.01 + nz } : null,
      accelIncludingGravity: { x: gVec.x + nx, y: gVec.y + ny, z: gVec.z + nz },
      rotationRateDegPerSec: { alpha: randn() * 0.8, beta: randn() * 0.8, gamma: randn() * 0.8 },
      orientationDeg: { alpha: 0, beta: betaDeg, gamma: gammaDeg },
    });
  }
  return samples;
}

/**
 * Generates a realistic minimum-jerk seated hand sweep:
 * - Initial positive acceleration lobe along sweep direction
 * - Followed by equal-area negative braking lobe bringing the hand back to rest!
 * Note: Because braking is equal and opposite, averaging signed acceleration over the whole stroke is ~0,
 * and an opposite-direction sweep has a positive braking lobe in the target direction!
 * This directly tests Section 7.4's requirement against naive averaging and braking-lobe false positives.
 */
export function generateRealisticSweepSamples(
  gestureId: GestureId,
  opts: SyntheticSweepOptions,
): MotionSample[] {
  const sampleRateHz = opts.sampleRateHz ?? 60;
  const durationMs = opts.durationMs ?? 440;
  const peakAccel = opts.peakAccelMps2 ?? 4.2;
  const angleOffsetRad = ((opts.angleOffsetDeg ?? 0) * Math.PI) / 180;
  const includeLinear = opts.includeLinearSensor ?? true;
  const betaDeg = opts.betaDeg ?? 55;
  const gammaDeg = opts.gammaDeg ?? 3;
  const noiseStd = opts.noiseStdMps2 ?? 0.08;

  const baseDir = GESTURE_SPECS[gestureId].desiredDir;
  const cosA = Math.cos(angleOffsetRad);
  const sinA = Math.sin(angleOffsetRad);
  const dirX = baseDir.x * cosA - baseDir.y * sinA;
  const dirY = baseDir.x * sinA + baseDir.y * cosA;

  const dtMs = 1000 / sampleRateHz;
  const prePadMs = 45;
  const postSettleMs = 90;
  const totalMs = prePadMs + durationMs + postSettleMs;
  const count = Math.floor(totalMs / dtMs);
  const randn = createSeededNoise(opts.seed ?? 777);
  const gVec = computeW3CGravityReaction(betaDeg, gammaDeg, 1);

  const samples: MotionSample[] = [];
  for (let i = 0; i < count; i++) {
    const tMs = i * dtMs;
    let aScalar = 0;
    if (tMs >= prePadMs && tMs <= prePadMs + durationMs) {
      // Full sine wave: +peak in first half (acceleration), -peak in second half (braking to zero velocity)
      const u = (tMs - prePadMs) / durationMs;
      aScalar = peakAccel * Math.sin(2 * Math.PI * u);
    }

    const ax = dirX * aScalar + randn() * noiseStd;
    const ay = dirY * aScalar + randn() * noiseStd;
    const az = randn() * noiseStd;

    samples.push({
      timestampMs: opts.startTimestampMs + tMs,
      linearAccel: includeLinear ? { x: ax, y: ay, z: az } : null,
      accelIncludingGravity: { x: gVec.x + ax, y: gVec.y + ay, z: gVec.z + az },
      rotationRateDegPerSec: { alpha: randn() * 2, beta: randn() * 2, gamma: randn() * 2 },
      orientationDeg: { alpha: 0, beta: betaDeg, gamma: gammaDeg },
    });
  }

  return samples;
}

export function generatePureTiltSamples(
  startTimestampMs: number,
  durationMs = 500,
  sampleRateHz = 60,
  includeLinearSensor = false,
  startBeta = 55,
  startGamma = 0,
  deltaGammaDeg = 32,
): MotionSample[] {
  const dtMs = 1000 / sampleRateHz;
  const count = Math.floor(durationMs / dtMs);
  const samples: MotionSample[] = [];

  for (let i = 0; i < count; i++) {
    const tMs = i * dtMs;
    const u = Math.min(1, tMs / (durationMs * 0.7));
    const gammaNow = startGamma + deltaGammaDeg * (0.5 - 0.5 * Math.cos(Math.PI * u));
    const gammaRate =
      tMs <= durationMs * 0.7
        ? (deltaGammaDeg * 0.5 * Math.PI * Math.sin(Math.PI * u)) / ((durationMs * 0.7) / 1000)
        : 0;
    const gNow = computeW3CGravityReaction(startBeta, gammaNow, 1);

    samples.push({
      timestampMs: startTimestampMs + tMs,
      linearAccel: includeLinearSensor ? { x: 0.08, y: -0.04, z: 0.02 } : null,
      accelIncludingGravity: { x: gNow.x, y: gNow.y, z: gNow.z },
      rotationRateDegPerSec: { alpha: 0, beta: 0, gamma: gammaRate },
      orientationDeg: { alpha: 0, beta: startBeta, gamma: gammaNow },
    });
  }

  return samples;
}
