import { GESTURE_SPECS, RECOGNIZER_DEFAULTS } from '../shared/constants.js';
import type { AttemptMachineState, GestureId } from '../shared/types.js';
import type { MotionSample, RecognizedStrokeCandidate, RecognizerStepUpdate } from './types.js';

const RAD_TO_DEG = 180 / Math.PI;

function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Explicit directional-tilt fallback recognizer (Section 7.6).
 * Never used silently; requires explicit user/facilitator fallback selection and reports `inputMethod: 'tilt'`.
 */
export class TiltFallbackRecognizer {
  private state: AttemptMachineState = 'released';
  private gestureId: GestureId;
  private refOrientation: { beta: number; gamma: number } | null = null;
  private attemptSeq = 0;
  private attemptId = '';
  private pressAtMs = 0;
  private progress = 0;
  private reasonText = 'Tilt fallback ready';

  constructor(gestureId: GestureId) {
    this.gestureId = gestureId;
  }

  setGesture(gestureId: GestureId): void {
    this.gestureId = gestureId;
    this.cancelAttempt();
  }

  getState(): AttemptMachineState {
    return this.state;
  }

  getAttemptMeta(): { attemptId: string; attemptSeq: number } {
    return { attemptId: this.attemptId, attemptSeq: this.attemptSeq };
  }

  beginAttempt(nowMs: number, currentOri: { beta: number; gamma: number } | null): RecognizerStepUpdate {
    this.attemptSeq += 1;
    this.attemptId = makeId('tatt');
    this.pressAtMs = nowMs;
    this.refOrientation = currentOri ? { ...currentOri } : null;
    this.state = 'armed';
    this.progress = 0.05;
    this.reasonText = `Tilt phone in direction: ${GESTURE_SPECS[this.gestureId].shortLabel}`;
    return {
      state: this.state,
      justLatchedSuccess: false,
      justLatchedFailure: false,
      rejectionCode: 'NONE',
      reasonText: this.reasonText,
      progress: this.progress,
    };
  }

  releaseAttempt(): RecognizerStepUpdate {
    this.state = 'released';
    this.progress = 0;
    this.reasonText = 'Return phone upright while released';
    return {
      state: 'released',
      justLatchedSuccess: false,
      justLatchedFailure: false,
      rejectionCode: 'NONE',
      reasonText: this.reasonText,
      progress: 0,
    };
  }

  cancelAttempt(reason = 'Tilt attempt canceled'): RecognizerStepUpdate {
    this.state = 'released';
    this.progress = 0;
    return {
      state: 'released',
      justLatchedSuccess: false,
      justLatchedFailure: false,
      rejectionCode: 'CANCELED_INTERRUPTED',
      reasonText: reason,
      progress: 0,
    };
  }

  pushSample(sample: MotionSample): RecognizerStepUpdate {
    if (
      this.state === 'released' ||
      this.state === 'recognized_locked' ||
      this.state === 'failed_locked'
    ) {
      return {
        state: this.state,
        justLatchedSuccess: false,
        justLatchedFailure: false,
        rejectionCode: 'NONE',
        reasonText: this.reasonText,
        progress: this.progress,
      };
    }

    const ori = sample.orientationDeg;
    if (!ori || ori.beta == null || ori.gamma == null) {
      return {
        state: this.state,
        justLatchedSuccess: false,
        justLatchedFailure: false,
        rejectionCode: 'NONE',
        reasonText: 'Waiting for orientation sensor...',
        progress: this.progress,
      };
    }

    if (!this.refOrientation) {
      this.refOrientation = { beta: ori.beta, gamma: ori.gamma };
    }

    // Map gamma (+right roll) -> +x, -beta delta (tilting top forward/away vs toward) -> y
    const dx = ori.gamma - this.refOrientation.gamma;
    const dy = -(ori.beta - this.refOrientation.beta);
    const tiltMag = Math.hypot(dx, dy);
    const threshold = RECOGNIZER_DEFAULTS.tiltFallbackThresholdDeg;

    if (tiltMag < 6) {
      return {
        state: this.state,
        justLatchedSuccess: false,
        justLatchedFailure: false,
        rejectionCode: 'NONE',
        reasonText: this.reasonText,
        progress: 0.08,
      };
    }

    this.state = 'tracking';
    const desired = GESTURE_SPECS[this.gestureId].desiredDir;
    const cosAngle = Math.max(-1, Math.min(1, (dx * desired.x + dy * desired.y) / tiltMag));
    const angleErr = Math.acos(cosAngle) * RAD_TO_DEG;

    if (tiltMag >= 10 && angleErr > 50) {
      this.state = 'failed_locked';
      this.progress = 0;
      this.reasonText = `Wrong tilt direction (${Math.round(angleErr)}° off)`;
      return {
        state: 'failed_locked',
        justLatchedSuccess: false,
        justLatchedFailure: true,
        rejectionCode: 'WRONG_DIRECTION',
        reasonText: this.reasonText,
        progress: 0,
      };
    }

    this.progress = Math.min(1, tiltMag / threshold);
    if (tiltMag >= threshold && sample.timestampMs - this.pressAtMs >= 160) {
      this.state = 'recognized_locked';
      this.progress = 1;
      this.reasonText = 'Tilt recognized! Release before returning upright';
      const candidate: RecognizedStrokeCandidate = {
        strokeId: makeId('tstk'),
        attemptId: this.attemptId,
        attemptSeq: this.attemptSeq,
        gestureId: this.gestureId,
        durationMs: Math.round(sample.timestampMs - this.pressAtMs),
        peakSignalMps2: Number(tiltMag.toFixed(1)),
        forwardImpulseMps: 1,
        workingAngleDeg: Number((Math.atan2(dy, dx) * RAD_TO_DEG).toFixed(1)),
        targetAngleDeg: Number((Math.atan2(desired.y, desired.x) * RAD_TO_DEG).toFixed(1)),
        angleErrorDeg: Number(angleErr.toFixed(1)),
        consistency: 1,
      };
      return {
        state: 'recognized_locked',
        justLatchedSuccess: true,
        justLatchedFailure: false,
        rejectionCode: 'NONE',
        reasonText: this.reasonText,
        progress: 1,
        strokeCandidate: candidate,
      };
    }

    return {
      state: 'tracking',
      justLatchedSuccess: false,
      justLatchedFailure: false,
      rejectionCode: 'NONE',
      reasonText: 'Tilting...',
      progress: this.progress,
    };
  }
}
