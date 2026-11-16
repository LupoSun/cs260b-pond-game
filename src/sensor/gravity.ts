import { RECOGNIZER_DEFAULTS } from '../shared/constants.js';
import type { ExtendedCalibrationData, MotionSample, Vec3 } from './types.js';

const GRAVITY_MPS2 = 9.80665;
const DEG_TO_RAD = Math.PI / 180;

export function isValidVec3(v: Vec3 | null | undefined): v is Vec3 {
  return (
    v != null &&
    Number.isFinite(v.x) &&
    Number.isFinite(v.y) &&
    Number.isFinite(v.z)
  );
}

/**
 * Fallback sign heuristic used ONLY when `accelerationIncludingGravity` is completely absent.
 * iOS WebKit exposes static `DeviceMotionEvent.requestPermission` and maps CoreMotion `CMAcceleration`
 * with inverted sign (-1) relative to W3C / Android (+1).
 */
export function detectPlatformDefaultAccelSign(): 1 | -1 {
  if (
    typeof window !== 'undefined' &&
    'DeviceMotionEvent' in window &&
    typeof (window.DeviceMotionEvent as unknown as { requestPermission?: unknown })
      .requestPermission === 'function'
  ) {
    return -1;
  }
  return 1;
}

/**
 * Expected proper-acceleration vector due to gravity in portrait device frame
 * (+x right, +y up screen, +z out of screen) for pitch beta [-180..180] and roll gamma [-90..90].
 * - `sign = +1`: W3C / Android convention (flat face-up at rest -> z = +9.81, accelerating right -> x > 0)
 * - `sign = -1`: iOS CoreMotion / WebKit convention (flat face-up at rest -> z = -9.81, accelerating right -> x < 0)
 */
export function computeW3CGravityReaction(betaDeg: number, gammaDeg: number, sign: 1 | -1 = 1): Vec3 {
  const b = betaDeg * DEG_TO_RAD;
  const g = gammaDeg * DEG_TO_RAD;
  return {
    x: sign * (-GRAVITY_MPS2 * Math.cos(b) * Math.sin(g)),
    y: sign * (GRAVITY_MPS2 * Math.sin(b)),
    z: sign * (GRAVITY_MPS2 * Math.cos(b) * Math.cos(g)),
  };
}

/**
 * Determines whether the device reports W3C/Android (+1) or iOS CoreMotion (-1) acceleration signs
 * directly from stationary portrait gravity readings (with orientation cross-check when available).
 */
export function inferAccelSignConvention(
  gravityRef: Vec3 | null,
  orientationRef: { beta: number; gamma: number } | null,
  fallbackSign: 1 | -1 = 1,
): 1 | -1 {
  if (gravityRef) {
    if (orientationRef) {
      const posPred = computeW3CGravityReaction(orientationRef.beta, orientationRef.gamma, 1);
      const negPred = computeW3CGravityReaction(orientationRef.beta, orientationRef.gamma, -1);
      const errPos = Math.hypot(
        gravityRef.x - posPred.x,
        gravityRef.y - posPred.y,
        gravityRef.z - posPred.z,
      );
      const errNeg = Math.hypot(
        gravityRef.x - negPred.x,
        gravityRef.y - negPred.y,
        gravityRef.z - negPred.z,
      );
      if (Math.abs(errNeg - errPos) > 2.0) {
        return errNeg < errPos ? -1 : 1;
      }
    }

    // Even when DeviceOrientationEvent has not fired yet (common on stationary iPhones),
    // any comfortable portrait hold (flat face-up beta=0 deg through vertical beta=90 deg)
    // has sin(beta) + cos(beta) > +0.7g (+6.8 to +13.8 m/s^2) in W3C/Android (+1)
    // and < -0.7g (-6.8 to -13.8 m/s^2) in iOS CoreMotion (-1).
    const portraitFaceUpSum = gravityRef.y + gravityRef.z;
    if (portraitFaceUpSum < -2.5) return -1;
    if (portraitFaceUpSum > 2.5) return 1;
  }

  return fallbackSign;
}

/**
 * Captures stationary samples (0.5 - 1.0s) to measure sensor bias, RMS noise floor,
 * sample delivery rate, hardware linear acceleration availability, and axis sign convention (+1 vs -1).
 */
export class StationaryCalibrator {
  private samples: MotionSample[] = [];
  private versionCounter = 0;

  resetSamples(): void {
    this.samples = [];
  }

  pushSample(sample: MotionSample): void {
    if (!Number.isFinite(sample.timestampMs)) return;
    this.samples.push(sample);
  }

  getSampleCount(): number {
    return this.samples.length;
  }

  finalize(previousVersion = 0, practicePeakSignalsMps2: number[] = []): ExtendedCalibrationData {
    const nextVersion = Math.max(previousVersion, this.versionCounter) + 1;
    this.versionCounter = nextVersion;
    const defaultSign = detectPlatformDefaultAccelSign();

    if (this.samples.length < 5) {
      return {
        version: nextVersion,
        validated: false,
        stationaryBias: { x: 0, y: 0, z: 0 },
        stationaryNoiseRms: 0.15,
        onsetThreshold: RECOGNIZER_DEFAULTS.minOnsetThresholdMps2,
        minPeakSignal: RECOGNIZER_DEFAULTS.minPeakSignalMps2,
        measuredSampleRateHz: 0,
        hasLinearAcceleration: false,
        gravityRef: { x: 0, y: 7.0 * defaultSign, z: 6.8 * defaultSign },
        orientationRef: null,
        gravitySignConvention: defaultSign,
      };
    }

    const firstTs = this.samples[0].timestampMs;
    const lastTs = this.samples[this.samples.length - 1].timestampMs;
    const spanSec = Math.max(0.001, (lastTs - firstTs) / 1000);
    const measuredSampleRateHz = (this.samples.length - 1) / spanSec;

    const linearSamples = this.samples
      .map((s) => s.linearAccel)
      .filter((v): v is Vec3 => isValidVec3(v));
    const incGSamples = this.samples
      .map((s) => s.accelIncludingGravity)
      .filter((v): v is Vec3 => isValidVec3(v));

    // Check if linearAccel exists for >= 80% of samples; if all linear samples are exact 0.000000 while incG varies, treat as unsupported
    let hasLinear = linearSamples.length >= Math.ceil(this.samples.length * 0.8);
    if (hasLinear && incGSamples.length > 0 && linearSamples.length >= 6) {
      const allExactZero = linearSamples.every((v) => v.x === 0 && v.y === 0 && v.z === 0);
      const incGVaries = incGSamples.some(
        (v) =>
          Math.abs(v.x - incGSamples[0].x) > 1e-6 ||
          Math.abs(v.y - incGSamples[0].y) > 1e-6 ||
          Math.abs(v.z - incGSamples[0].z) > 1e-6,
      );
      if (allExactZero && incGVaries) {
        hasLinear = false;
      }
    }

    const activeVecs = hasLinear ? linearSamples : incGSamples;
    if (activeVecs.length < 5) {
      return {
        version: nextVersion,
        validated: false,
        stationaryBias: { x: 0, y: 0, z: 0 },
        stationaryNoiseRms: 0.2,
        onsetThreshold: RECOGNIZER_DEFAULTS.minOnsetThresholdMps2,
        minPeakSignal: RECOGNIZER_DEFAULTS.minPeakSignalMps2,
        measuredSampleRateHz,
        hasLinearAcceleration: false,
        gravityRef: { x: 0, y: 7.0 * defaultSign, z: 6.8 * defaultSign },
        orientationRef: null,
        gravitySignConvention: defaultSign,
      };
    }

    const mean = activeVecs.reduce(
      (acc, v) => ({
        x: acc.x + v.x / activeVecs.length,
        y: acc.y + v.y / activeVecs.length,
        z: acc.z + v.z / activeVecs.length,
      }),
      { x: 0, y: 0, z: 0 },
    );

    const varianceSum = activeVecs.reduce((sum, v) => {
      const dx = v.x - mean.x;
      const dy = v.y - mean.y;
      return sum + dx * dx + dy * dy;
    }, 0);
    const stationaryNoiseRms = Math.sqrt(varianceSum / activeVecs.length);

    const oriSamples = this.samples
      .map((s) => s.orientationDeg)
      .filter(
        (o): o is { alpha: number | null; beta: number; gamma: number } =>
          o != null && o.beta != null && o.gamma != null && Number.isFinite(o.beta) && Number.isFinite(o.gamma),
      );

    let orientationRef: { beta: number; gamma: number } | null = null;
    if (oriSamples.length > 0) {
      const betaAvg = oriSamples.reduce((s, o) => s + o.beta, 0) / oriSamples.length;
      const gammaAvg = oriSamples.reduce((s, o) => s + o.gamma, 0) / oriSamples.length;
      orientationRef = { beta: betaAvg, gamma: gammaAvg };
    }

    const measuredGravityRef =
      incGSamples.length > 0
        ? incGSamples.reduce(
            (acc, v) => ({
              x: acc.x + v.x / incGSamples.length,
              y: acc.y + v.y / incGSamples.length,
              z: acc.z + v.z / incGSamples.length,
            }),
            { x: 0, y: 0, z: 0 },
          )
        : null;

    const gravitySignConvention = inferAccelSignConvention(
      measuredGravityRef,
      orientationRef,
      defaultSign,
    );

    const gravityRef = measuredGravityRef ?? {
      x: 0,
      y: 0,
      z: GRAVITY_MPS2 * gravitySignConvention,
    };

    const onsetThreshold = Math.min(
      3.0,
      Math.max(
        RECOGNIZER_DEFAULTS.minOnsetThresholdMps2,
        stationaryNoiseRms * RECOGNIZER_DEFAULTS.noiseOnsetMultiplier + 0.35,
      ),
    );

    let minPeakSignal: number = RECOGNIZER_DEFAULTS.minPeakSignalMps2;
    if (practicePeakSignalsMps2.length >= 2) {
      const sorted = [...practicePeakSignalsMps2].sort((a, b) => a - b);
      const comfortableFloor = sorted[0] * 0.65;
      minPeakSignal = Math.min(3.8, Math.max(1.45, comfortableFloor));
    }

    // Reject calibration if user was wildly shaking the phone during stationary reference capture
    const validated = stationaryNoiseRms < 1.8;

    return {
      version: nextVersion,
      validated,
      stationaryBias: hasLinear ? mean : { x: 0, y: 0, z: 0 },
      stationaryNoiseRms,
      onsetThreshold,
      minPeakSignal,
      measuredSampleRateHz,
      hasLinearAcceleration: hasLinear,
      gravityRef,
      orientationRef,
      gravitySignConvention,
    };
  }
}

/**
 * Stateful gravity-removal and axis-sign normalizer that maps raw DeviceMotionEvent samples
 * into W3C portrait screen-plane linear acceleration (+x right, +y up) identically on iOS and Android.
 */
export class GravityCompensator {
  private slowGravityEst: Vec3 = { x: 0, y: 7.0, z: 6.8 };
  private filteredXY = { x: 0, y: 0, z: 0 };
  private initialized = false;

  reset(calibration: ExtendedCalibrationData | null): void {
    if (calibration) {
      this.slowGravityEst = { ...calibration.gravityRef };
    }
    this.filteredXY = { x: 0, y: 0, z: 0 };
    this.initialized = false;
  }

  extractScreenLinear(
    sample: MotionSample,
    dtSec: number,
    calibration: ExtendedCalibrationData,
    isReleased: boolean,
  ): { linear: Vec3; raw: Vec3; usedLinearSensor: boolean } {
    const sign = calibration.gravitySignConvention ?? 1;
    const useLinear = calibration.hasLinearAcceleration && isValidVec3(sample.linearAccel);
    let raw: Vec3;
    let unsmoothed: Vec3;

    if (useLinear && sample.linearAccel) {
      raw = sample.linearAccel;
      // Multiply by `sign` (-1 on iOS WebKit / CoreMotion, +1 on W3C / Android) so accelerating right is ALWAYS +x
      // and accelerating upward along the screen is ALWAYS +y!
      unsmoothed = {
        x: sign * (raw.x - calibration.stationaryBias.x),
        y: sign * (raw.y - calibration.stationaryBias.y),
        z: sign * (raw.z - calibration.stationaryBias.z),
      };
    } else if (isValidVec3(sample.accelIncludingGravity)) {
      raw = sample.accelIncludingGravity;
      const ori = sample.orientationDeg;
      if (
        ori &&
        ori.beta != null &&
        ori.gamma != null &&
        Number.isFinite(ori.beta) &&
        Number.isFinite(ori.gamma) &&
        calibration.orientationRef
      ) {
        const gAtRef = computeW3CGravityReaction(
          calibration.orientationRef.beta,
          calibration.orientationRef.gamma,
          sign,
        );
        const gNow = computeW3CGravityReaction(
          ori.beta,
          ori.gamma,
          sign,
        );
        const expectedGravity = {
          x: calibration.gravityRef.x + (gNow.x - gAtRef.x),
          y: calibration.gravityRef.y + (gNow.y - gAtRef.y),
          z: calibration.gravityRef.z + (gNow.z - gAtRef.z),
        };
        unsmoothed = {
          x: sign * (raw.x - expectedGravity.x),
          y: sign * (raw.y - expectedGravity.y),
          z: sign * (raw.z - expectedGravity.z),
        };
      } else {
        const mag = Math.hypot(raw.x, raw.y, raw.z);
        const near1g = Math.abs(mag - GRAVITY_MPS2) < 1.2;
        const tauSec = isReleased && near1g ? 0.28 : 1.8;
        const alphaG = 1 - Math.exp(-dtSec / tauSec);
        this.slowGravityEst = {
          x: this.slowGravityEst.x + alphaG * (raw.x - this.slowGravityEst.x),
          y: this.slowGravityEst.y + alphaG * (raw.y - this.slowGravityEst.y),
          z: this.slowGravityEst.z + alphaG * (raw.z - this.slowGravityEst.z),
        };
        unsmoothed = {
          x: sign * (raw.x - this.slowGravityEst.x),
          y: sign * (raw.y - this.slowGravityEst.y),
          z: sign * (raw.z - this.slowGravityEst.z),
        };
      }
    } else {
      raw = { x: 0, y: 0, z: 0 };
      unsmoothed = { x: 0, y: 0, z: 0 };
    }

    // Sampling-rate-independent light low-pass filter (tau = 16ms) to suppress single-tick MEMS spikes
    const smoothTauSec = 0.016;
    const alpha = this.initialized ? 1 - Math.exp(-dtSec / smoothTauSec) : 1;
    this.initialized = true;
    this.filteredXY = {
      x: this.filteredXY.x + alpha * (unsmoothed.x - this.filteredXY.x),
      y: this.filteredXY.y + alpha * (unsmoothed.y - this.filteredXY.y),
      z: this.filteredXY.z + alpha * (unsmoothed.z - this.filteredXY.z),
    };

    return {
      linear: { ...this.filteredXY },
      raw,
      usedLinearSensor: useLinear,
    };
  }
}
