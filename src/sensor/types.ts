import type {
  AttemptMachineState,
  CalibrationSummary,
  GestureId,
  RecognitionRejectionCode,
} from '../shared/types.js';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface MotionSample {
  /** Monotonic timestamp in milliseconds */
  timestampMs: number;
  /** Gravity-compensated linear acceleration in device frame (m/s^2), if provided by browser */
  linearAccel: Vec3 | null;
  /** Proper acceleration including gravity in device frame (m/s^2), if provided by browser */
  accelIncludingGravity: Vec3 | null;
  /** Rotation rate in deg/sec (alpha: z, beta: x, gamma: y) */
  rotationRateDegPerSec: { alpha: number; beta: number; gamma: number } | null;
  /** Orientation angles in degrees (alpha: compass/z, beta: pitch/x, gamma: roll/y) */
  orientationDeg: { alpha: number | null; beta: number | null; gamma: number | null } | null;
}

export interface ProcessedMotionSample {
  timestampMs: number;
  dtSec: number;
  rawX: number;
  rawY: number;
  rawZ: number;
  /** Filtered, gravity-compensated linear acceleration in portrait screen plane (+x right, +y up) */
  screenX: number;
  screenY: number;
  screenZ: number;
  magnitudeXY: number;
  usedLinearSensor: boolean;
  angularSpeedDegPerSec: number;
}

export interface RecognizedStrokeCandidate {
  strokeId: string;
  attemptId: string;
  attemptSeq: number;
  gestureId: GestureId;
  durationMs: number;
  peakSignalMps2: number;
  forwardImpulseMps: number;
  workingAngleDeg: number;
  targetAngleDeg: number;
  angleErrorDeg: number;
  consistency: number;
}

export interface RecognizerStepUpdate {
  state: AttemptMachineState;
  justLatchedSuccess: boolean;
  justLatchedFailure: boolean;
  rejectionCode: RecognitionRejectionCode;
  reasonText: string;
  /** Normalized gesture progress [0..1] for limb animation preview (never hand position in cm) */
  progress: number;
  processedSample?: ProcessedMotionSample;
  strokeCandidate?: RecognizedStrokeCandidate;
}

export interface ExtendedCalibrationData extends CalibrationSummary {
  gravityRef: Vec3;
  orientationRef: { beta: number; gamma: number } | null;
  gravitySignConvention: 1 | -1;
}
