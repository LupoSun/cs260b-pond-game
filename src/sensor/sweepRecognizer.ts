import { GESTURE_SPECS, RECOGNIZER_DEFAULTS } from '../shared/constants.js';
import type {
  AttemptMachineState,
  GestureId,
  RecognitionRejectionCode,
} from '../shared/types.js';
import { GravityCompensator } from './gravity.js';
import type {
  ExtendedCalibrationData,
  MotionSample,
  ProcessedMotionSample,
  RecognizedStrokeCandidate,
  RecognizerStepUpdate,
} from './types.js';

const RAD_TO_DEG = 180 / Math.PI;

export interface SweepRecognizerConfig {
  pressTransientIgnoreMs: number;
  minAttemptDurationMs: number;
  maxAttemptDurationMs: number;
  directionToleranceDeg: number;
  minForwardVelocityImpulseMps: number;
  minDirectionalConsistency: number;
  pureTiltRejectDeg: number;
}

function makeUniqueId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}

/**
 * Local press-stroke-release state machine and physical-sweep recognizer (Sections 7.3 - 7.5).
 *
 * Key invariants enforced:
 * - At most ONE stroke candidate per button press (`recognized_locked` latches until `releaseAttempt()`).
 * - Return movement while `released` is completely ignored for gameplay.
 * - Direction is evaluated strictly from the FIRST significant acceleration segment (lobe 1),
 *   so braking acceleration in the opposite direction never turns a wrong-way sweep into a hit.
 * - Sampling-rate-independent time integrals (`dtSec`) prevent frame-rate bias.
 */
export class PhysicalSweepRecognizer {
  private state: AttemptMachineState = 'released';
  private gestureId: GestureId;
  private calibration: ExtendedCalibrationData | null = null;
  private readonly gravityCompensator = new GravityCompensator();
  private readonly config: SweepRecognizerConfig;

  private lastTimestampMs: number | null = null;
  private attemptSeq = 0;
  private currentAttemptId = '';
  private pressStartedAtMs = 0;

  // Onset & tracking accumulators
  private aboveOnsetAccumSec = 0;
  private trackingStartedAtMs = 0;
  private lobe1Ended = false;
  private lobe1DurationSec = 0;
  private lobe1ImpulseX = 0;
  private lobe1ImpulseY = 0;
  private lobe1EffortIntegral = 0;
  private lobe1PeakSignalMps2 = 0;

  // Post-lobe deceleration / settling tracking
  private brakingImpulseForward = 0;
  private settledAccumSec = 0;
  private angularExcursionDeg = 0;
  private pressStartOrientation: { beta: number; gamma: number } | null = null;

  private lastRejectionCode: RecognitionRejectionCode = 'NONE';
  private lastReasonText = 'Ready: hold button and sweep cleanly';
  private currentProgress = 0;

  constructor(gestureId: GestureId, config?: Partial<SweepRecognizerConfig>) {
    this.gestureId = gestureId;
    this.config = {
      pressTransientIgnoreMs: RECOGNIZER_DEFAULTS.pressTransientIgnoreMs,
      minAttemptDurationMs: RECOGNIZER_DEFAULTS.minAttemptDurationMs,
      maxAttemptDurationMs: RECOGNIZER_DEFAULTS.maxAttemptDurationMs,
      directionToleranceDeg: RECOGNIZER_DEFAULTS.directionToleranceDeg,
      minForwardVelocityImpulseMps: RECOGNIZER_DEFAULTS.minForwardVelocityImpulseMps,
      minDirectionalConsistency: RECOGNIZER_DEFAULTS.minDirectionalConsistency,
      pureTiltRejectDeg: RECOGNIZER_DEFAULTS.pureTiltRejectDeg,
      ...config,
    };
  }

  setGesture(gestureId: GestureId): void {
    this.gestureId = gestureId;
    this.cancelAttempt('Gesture updated');
  }

  getGesture(): GestureId {
    return this.gestureId;
  }

  setCalibration(calibration: ExtendedCalibrationData): void {
    this.calibration = calibration;
    this.gravityCompensator.reset(calibration);
    if (this.state !== 'released') {
      this.cancelAttempt('Calibration updated; press again');
    }
  }

  getCalibration(): ExtendedCalibrationData | null {
    return this.calibration;
  }

  getState(): AttemptMachineState {
    return this.state;
  }

  getAttemptMeta(): { attemptId: string; attemptSeq: number } {
    return { attemptId: this.currentAttemptId, attemptSeq: this.attemptSeq };
  }

  beginAttempt(nowMs: number, initialOrientation?: { beta: number; gamma: number } | null): RecognizerStepUpdate {
    if (!this.calibration || !this.calibration.validated) {
      this.state = 'failed_locked';
      this.lastRejectionCode = 'NOT_CALIBRATED';
      this.lastReasonText = 'Calibrate phone before paddling';
      this.currentProgress = 0;
      return this.snapshotUpdate(false, true);
    }

    this.attemptSeq += 1;
    this.currentAttemptId = makeUniqueId('att');
    this.pressStartedAtMs = nowMs;
    this.state = 'armed';

    this.aboveOnsetAccumSec = 0;
    this.trackingStartedAtMs = 0;
    this.lobe1Ended = false;
    this.lobe1DurationSec = 0;
    this.lobe1ImpulseX = 0;
    this.lobe1ImpulseY = 0;
    this.lobe1EffortIntegral = 0;
    this.lobe1PeakSignalMps2 = 0;
    this.brakingImpulseForward = 0;
    this.settledAccumSec = 0;
    this.angularExcursionDeg = 0;
    this.pressStartOrientation = initialOrientation ? { ...initialOrientation } : null;

    this.lastRejectionCode = 'NONE';
    this.lastReasonText = `Armed: ${GESTURE_SPECS[this.gestureId].instruction}`;
    this.currentProgress = 0.04;

    return this.snapshotUpdate(false, false);
  }

  releaseAttempt(nowMs: number): RecognizerStepUpdate {
    const prevState = this.state;
    const heldDurationMs = Math.max(0, nowMs - this.pressStartedAtMs);

    this.state = 'released';
    this.currentProgress = 0;

    if (prevState === 'recognized_locked') {
      this.lastRejectionCode = 'NONE';
      this.lastReasonText = 'Return comfortably while released';
      return this.snapshotUpdate(false, false);
    }

    if (prevState === 'failed_locked') {
      // Preserve specific failure feedback shown to the participant on release
      return this.snapshotUpdate(false, false);
    }

    if (prevState === 'armed') {
      if (heldDurationMs < this.config.minAttemptDurationMs) {
        this.lastRejectionCode = 'TOO_SHORT_TAP';
        this.lastReasonText = 'Quick tap ignored: hold while sweeping';
      } else {
        this.lastRejectionCode = 'STATIONARY_NO_MOTION';
        this.lastReasonText = 'No sweep felt: move smoothly before releasing';
      }
      return this.snapshotUpdate(false, true);
    }

    if (prevState === 'tracking') {
      // Released mid-motion: check if a crisp compact sweep had already met lobe1 criteria right at release!
      const finalizeAtRelease = this.tryFinalizeAtRelease(nowMs);
      if (finalizeAtRelease) {
        // Note: state transitions back to released immediately because finger lifted,
        // while emitting the single stroke candidate for this completed press!
        this.state = 'released';
        this.currentProgress = 0;
        return finalizeAtRelease;
      }

      if (heldDurationMs < this.config.minAttemptDurationMs) {
        this.lastRejectionCode = 'TOO_SHORT_TAP';
        this.lastReasonText = 'Sweep cut short: hold slightly longer through the sweep';
      } else {
        this.lastRejectionCode = 'WEAK_SIGNAL';
        this.lastReasonText = 'Gentle incomplete sweep: try a slightly clearer motion';
      }
      return this.snapshotUpdate(false, true);
    }

    return this.snapshotUpdate(false, false);
  }

  cancelAttempt(reason = 'Attempt canceled; release and press again'): RecognizerStepUpdate {
    const wasActive = this.state !== 'released';
    this.state = 'released';
    this.currentProgress = 0;
    if (wasActive) {
      this.lastRejectionCode = 'CANCELED_INTERRUPTED';
      this.lastReasonText = reason;
    }
    return this.snapshotUpdate(false, false);
  }

  pushSample(sample: MotionSample): RecognizerStepUpdate {
    const rawDtSec =
      this.lastTimestampMs != null ? (sample.timestampMs - this.lastTimestampMs) / 1000 : 1 / 60;
    this.lastTimestampMs = sample.timestampMs;

    // Guard against duplicate timestamps or background-tab timer jumps
    if (!Number.isFinite(rawDtSec) || rawDtSec <= 0) {
      return this.snapshotUpdate(false, false);
    }
    const dtSec = Math.min(0.12, Math.max(0.002, rawDtSec));

    if (!this.calibration) {
      return this.snapshotUpdate(false, false);
    }

    const isReleased = this.state === 'released';
    const { linear, raw, usedLinearSensor } = this.gravityCompensator.extractScreenLinear(
      sample,
      dtSec,
      this.calibration,
      isReleased,
    );

    const rot = sample.rotationRateDegPerSec;
    const angularSpeedDegPerSec =
      rot && Number.isFinite(rot.alpha) && Number.isFinite(rot.beta) && Number.isFinite(rot.gamma)
        ? Math.hypot(rot.alpha, rot.beta, rot.gamma)
        : 0;

    const magXY = Math.hypot(linear.x, linear.y);

    const processed: ProcessedMotionSample = {
      timestampMs: sample.timestampMs,
      dtSec,
      rawX: raw.x,
      rawY: raw.y,
      rawZ: raw.z,
      screenX: linear.x,
      screenY: linear.y,
      screenZ: linear.z,
      magnitudeXY: magXY,
      usedLinearSensor,
      angularSpeedDegPerSec,
    };

    // Ignore movement completely while released or already latched!
    if (
      this.state === 'released' ||
      this.state === 'recognized_locked' ||
      this.state === 'failed_locked'
    ) {
      return {
        ...this.snapshotUpdate(false, false),
        processedSample: processed,
      };
    }

    // Track net orientation angle excursion from press start (avoid unbounded integral of unsigned gyro tremor)
    if (
      sample.orientationDeg &&
      sample.orientationDeg.beta != null &&
      sample.orientationDeg.gamma != null &&
      Number.isFinite(sample.orientationDeg.beta) &&
      Number.isFinite(sample.orientationDeg.gamma)
    ) {
      if (!this.pressStartOrientation) {
        this.pressStartOrientation = {
          beta: sample.orientationDeg.beta,
          gamma: sample.orientationDeg.gamma,
        };
      } else {
        const oriDelta = Math.hypot(
          sample.orientationDeg.beta - this.pressStartOrientation.beta,
          sample.orientationDeg.gamma - this.pressStartOrientation.gamma,
        );
        this.angularExcursionDeg = Math.max(this.angularExcursionDeg, oriDelta);
      }
    } else if (!usedLinearSensor) {
      this.angularExcursionDeg += angularSpeedDegPerSec * dtSec;
    }

    const sincePressMs = sample.timestampMs - this.pressStartedAtMs;

    // 1. Suppress button-touch transient window immediately after press
    if (sincePressMs < this.config.pressTransientIgnoreMs) {
      return {
        ...this.snapshotUpdate(false, false),
        processedSample: processed,
      };
    }

    const onsetThreshold = this.calibration.onsetThreshold;
    const desired = GESTURE_SPECS[this.gestureId].desiredDir;
    const projDesired = linear.x * desired.x + linear.y * desired.y;

    // 2. ARMED state: wait for sustained intentional motion onset
    if (this.state === 'armed') {
      // Pure orientation tilt guard while stationary
      if (this.angularExcursionDeg > this.config.pureTiltRejectDeg && magXY < onsetThreshold * 0.9) {
        this.state = 'failed_locked';
        this.currentProgress = 0;
        this.lastRejectionCode = 'ORIENTATION_TILT_ONLY';
        this.lastReasonText = 'Phone tilted without sweeping: slide your hand across instead of tilting';
        return {
          ...this.snapshotUpdate(false, true),
          processedSample: processed,
        };
      }

      if (magXY >= onsetThreshold) {
        this.aboveOnsetAccumSec += dtSec;
        // Start integrating lobe 1 from onset start so initial impulse isn't lost
        this.lobe1DurationSec += dtSec;
        this.lobe1ImpulseX += linear.x * dtSec;
        this.lobe1ImpulseY += linear.y * dtSec;
        this.lobe1EffortIntegral += magXY * dtSec;
        this.lobe1PeakSignalMps2 = Math.max(this.lobe1PeakSignalMps2, magXY);

        if (this.aboveOnsetAccumSec >= 0.024) {
          this.state = 'tracking';
          this.trackingStartedAtMs = sample.timestampMs - this.aboveOnsetAccumSec * 1000;
          this.lastReasonText = 'Tracking sweep...';
        }
      } else {
        // Decay partial spike accumulator so isolated noise ticks never trigger tracking
        this.aboveOnsetAccumSec = Math.max(0, this.aboveOnsetAccumSec - dtSec * 2);
        if (this.aboveOnsetAccumSec === 0) {
          this.lobe1DurationSec = 0;
          this.lobe1ImpulseX = 0;
          this.lobe1ImpulseY = 0;
          this.lobe1EffortIntegral = 0;
          this.lobe1PeakSignalMps2 = 0;
        }
      }

      return {
        ...this.snapshotUpdate(false, false),
        processedSample: processed,
      };
    }

    // 3. TRACKING state: analyze first significant acceleration lobe & subsequent settling
    const trackingElapsedMs = sample.timestampMs - this.trackingStartedAtMs;
    if (trackingElapsedMs > this.config.maxAttemptDurationMs) {
      this.state = 'failed_locked';
      this.currentProgress = 0;
      this.lastRejectionCode = 'TOO_LONG_HOLD';
      this.lastReasonText = 'Attempt timed out: release and make one brisk, compact sweep';
      return {
        ...this.snapshotUpdate(false, true),
        processedSample: processed,
      };
    }

    const currentLobeMag = Math.hypot(this.lobe1ImpulseX, this.lobe1ImpulseY);
    if (!this.lobe1Ended) {
      // Check if acceleration has crossed out of the initial acceleration lobe (dropped low or reversed against lobe 1)
      const dotWithLobe1 =
        currentLobeMag > 0.04
          ? (linear.x * this.lobe1ImpulseX + linear.y * this.lobe1ImpulseY) / currentLobeMag
          : magXY;

      if (
        this.lobe1DurationSec >= 0.055 &&
        (magXY < onsetThreshold * 0.45 || dotWithLobe1 < 0 || this.lobe1DurationSec >= 0.55)
      ) {
        this.lobe1Ended = true;
      } else {
        this.lobe1DurationSec += dtSec;
        this.lobe1ImpulseX += linear.x * dtSec;
        this.lobe1ImpulseY += linear.y * dtSec;
        this.lobe1EffortIntegral += magXY * dtSec;
        this.lobe1PeakSignalMps2 = Math.max(this.lobe1PeakSignalMps2, magXY);
      }
    }

    // If a tiny thumb/grip micro-wobble ended before any real sweep impulse formed, re-arm cleanly
    // instead of latching WRONG_DIRECTION before the participant actually sweeps.
    const lobeImpulseMag = Math.hypot(this.lobe1ImpulseX, this.lobe1ImpulseY);
    if (this.lobe1Ended && lobeImpulseMag < 0.12) {
      this.state = 'armed';
      this.aboveOnsetAccumSec = 0;
      this.lobe1Ended = false;
      this.lobe1DurationSec = 0;
      this.lobe1ImpulseX = 0;
      this.lobe1ImpulseY = 0;
      this.lobe1EffortIntegral = 0;
      this.lobe1PeakSignalMps2 = 0;
      this.brakingImpulseForward = 0;
      this.settledAccumSec = 0;
      return {
        ...this.snapshotUpdate(false, false),
        processedSample: processed,
      };
    }

    // Evaluate first-segment direction once lobe 1 has meaningful sweep impulse!
    if (lobeImpulseMag >= 0.14 || this.lobe1Ended) {
      const check = this.evaluateLobe1Direction();
      if (!check.directionOk) {
        this.state = 'failed_locked';
        this.currentProgress = 0;
        this.lastRejectionCode = check.code;
        this.lastReasonText = check.reason;
        return {
          ...this.snapshotUpdate(false, true),
          processedSample: processed,
        };
      }
    }

    const forwardImpulse = this.lobe1ImpulseX * desired.x + this.lobe1ImpulseY * desired.y;
    const targetImpulse = Math.max(this.config.minForwardVelocityImpulseMps, 0.24);

    // Update normalized gesture progress [0..0.9] during active motion
    this.currentProgress = Math.min(0.92, Math.max(0.08, (forwardImpulse / targetImpulse) * 0.82));

    // Track deceleration / settling after initial acceleration peak
    if (projDesired < -0.25) {
      this.brakingImpulseForward += -projDesired * dtSec;
    }
    if (this.lobe1Ended && magXY <= onsetThreshold * 0.65) {
      this.settledAccumSec += dtSec;
    } else if (!this.lobe1Ended && projDesired < this.lobe1PeakSignalMps2 * 0.35 && this.lobe1DurationSec >= 0.12) {
      this.settledAccumSec += dtSec * 0.5;
    }

    const totalAttemptDurationMs = sample.timestampMs - this.pressStartedAtMs;
    const hasSettledOrBraked =
      this.lobe1Ended &&
      (this.settledAccumSec >= 0.032 || this.brakingImpulseForward >= forwardImpulse * 0.18);

    if (
      hasSettledOrBraked &&
      totalAttemptDurationMs >= this.config.minAttemptDurationMs
    ) {
      return this.finalizeCandidate(sample.timestampMs, processed);
    }

    return {
      ...this.snapshotUpdate(false, false),
      processedSample: processed,
    };
  }

  private evaluateLobe1Direction(): {
    directionOk: boolean;
    code: RecognitionRejectionCode;
    reason: string;
    angleErrorDeg: number;
    workingAngleDeg: number;
    targetAngleDeg: number;
    consistency: number;
  } {
    const desired = GESTURE_SPECS[this.gestureId].desiredDir;
    const targetAngleDeg = Math.atan2(desired.y, desired.x) * RAD_TO_DEG;
    const lobeMag = Math.hypot(this.lobe1ImpulseX, this.lobe1ImpulseY);

    if (lobeMag < 1e-4) {
      return {
        directionOk: false,
        code: 'STATIONARY_NO_MOTION',
        reason: 'No directional sweep detected',
        angleErrorDeg: 180,
        workingAngleDeg: 0,
        targetAngleDeg,
        consistency: 0,
      };
    }

    const workingAngleDeg = Math.atan2(this.lobe1ImpulseY, this.lobe1ImpulseX) * RAD_TO_DEG;
    const cosTheta = Math.max(-1, Math.min(1, (this.lobe1ImpulseX * desired.x + this.lobe1ImpulseY * desired.y) / lobeMag));
    const angleErrorDeg = Math.acos(cosTheta) * RAD_TO_DEG;
    const consistency = this.lobe1EffortIntegral > 0 ? lobeMag / this.lobe1EffortIntegral : 0;

    if (angleErrorDeg > this.config.directionToleranceDeg) {
      return {
        directionOk: false,
        code: 'WRONG_DIRECTION',
        reason: `Wrong direction (${Math.round(angleErrorDeg)}° off): ${GESTURE_SPECS[this.gestureId].instruction.toLowerCase()}`,
        angleErrorDeg,
        workingAngleDeg,
        targetAngleDeg,
        consistency,
      };
    }

    if (consistency < this.config.minDirectionalConsistency) {
      return {
        directionOk: false,
        code: 'LOW_DIRECTIONAL_CONSISTENCY',
        reason: 'Wobbly path: sweep smoothly in one straight direction',
        angleErrorDeg,
        workingAngleDeg,
        targetAngleDeg,
        consistency,
      };
    }

    return {
      directionOk: true,
      code: 'NONE',
      reason: 'Direction aligned',
      angleErrorDeg,
      workingAngleDeg,
      targetAngleDeg,
      consistency,
    };
  }

  private tryFinalizeAtRelease(nowMs: number): RecognizerStepUpdate | null {
    const totalAttemptDurationMs = nowMs - this.pressStartedAtMs;
    if (totalAttemptDurationMs < this.config.minAttemptDurationMs) {
      return null;
    }
    const check = this.evaluateLobe1Direction();
    if (!check.directionOk) {
      this.lastRejectionCode = check.code;
      this.lastReasonText = check.reason;
      return null;
    }
    const desired = GESTURE_SPECS[this.gestureId].desiredDir;
    const forwardImpulse = this.lobe1ImpulseX * desired.x + this.lobe1ImpulseY * desired.y;
    const minPeak = this.calibration?.minPeakSignal ?? RECOGNIZER_DEFAULTS.minPeakSignalMps2;
    const hasHwLinear = Boolean(this.calibration?.hasLinearAcceleration);

    if (
      forwardImpulse >= this.config.minForwardVelocityImpulseMps &&
      this.lobe1PeakSignalMps2 >= minPeak &&
      !(!hasHwLinear && this.angularExcursionDeg > this.config.pureTiltRejectDeg * 1.8 && forwardImpulse < 0.3)
    ) {
      return this.finalizeCandidate(nowMs);
    }
    return null;
  }

  private finalizeCandidate(
    nowMs: number,
    processed?: ProcessedMotionSample,
  ): RecognizerStepUpdate {
    const check = this.evaluateLobe1Direction();
    if (!check.directionOk) {
      this.state = 'failed_locked';
      this.currentProgress = 0;
      this.lastRejectionCode = check.code;
      this.lastReasonText = check.reason;
      return {
        ...this.snapshotUpdate(false, true),
        processedSample: processed,
      };
    }

    const desired = GESTURE_SPECS[this.gestureId].desiredDir;
    const forwardImpulse = this.lobe1ImpulseX * desired.x + this.lobe1ImpulseY * desired.y;
    const minPeak = this.calibration?.minPeakSignal ?? RECOGNIZER_DEFAULTS.minPeakSignalMps2;
    const hasHwLinear = Boolean(this.calibration?.hasLinearAcceleration);

    if (!hasHwLinear && this.angularExcursionDeg > this.config.pureTiltRejectDeg * 1.8 && forwardImpulse < 0.3) {
      this.state = 'failed_locked';
      this.currentProgress = 0;
      this.lastRejectionCode = 'ORIENTATION_TILT_ONLY';
      this.lastReasonText = 'Wrist rotation detected instead of a sweep';
      return {
        ...this.snapshotUpdate(false, true),
        processedSample: processed,
      };
    }

    if (
      forwardImpulse < this.config.minForwardVelocityImpulseMps ||
      this.lobe1PeakSignalMps2 < minPeak
    ) {
      this.state = 'failed_locked';
      this.currentProgress = 0;
      this.lastRejectionCode = 'WEAK_SIGNAL';
      this.lastReasonText = 'Sweep too light: move 10 to 20 cm with a clear start';
      return {
        ...this.snapshotUpdate(false, true),
        processedSample: processed,
      };
    }

    const durationMs = Math.round(nowMs - this.pressStartedAtMs);
    const candidate: RecognizedStrokeCandidate = {
      strokeId: makeUniqueId('stk'),
      attemptId: this.currentAttemptId,
      attemptSeq: this.attemptSeq,
      gestureId: this.gestureId,
      durationMs,
      peakSignalMps2: Number(this.lobe1PeakSignalMps2.toFixed(2)),
      forwardImpulseMps: Number(forwardImpulse.toFixed(3)),
      workingAngleDeg: Number(check.workingAngleDeg.toFixed(1)),
      targetAngleDeg: Number(check.targetAngleDeg.toFixed(1)),
      angleErrorDeg: Number(check.angleErrorDeg.toFixed(1)),
      consistency: Number(check.consistency.toFixed(2)),
    };

    this.state = 'recognized_locked';
    this.currentProgress = 1.0;
    this.lastRejectionCode = 'NONE';
    this.lastReasonText = 'Motion recognized! Release to reset paddle';

    return {
      state: this.state,
      justLatchedSuccess: true,
      justLatchedFailure: false,
      rejectionCode: 'NONE',
      reasonText: this.lastReasonText,
      progress: 1.0,
      processedSample: processed,
      strokeCandidate: candidate,
    };
  }

  private snapshotUpdate(
    justLatchedSuccess: boolean,
    justLatchedFailure: boolean,
  ): RecognizerStepUpdate {
    return {
      state: this.state,
      justLatchedSuccess,
      justLatchedFailure,
      rejectionCode: this.lastRejectionCode,
      reasonText: this.lastReasonText,
      progress: this.currentProgress,
    };
  }
}
