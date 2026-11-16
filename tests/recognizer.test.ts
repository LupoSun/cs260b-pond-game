import { describe, expect, it } from 'vitest';
import { StationaryCalibrator, computeW3CGravityReaction } from '../src/sensor/gravity.js';
import { PhysicalSweepRecognizer } from '../src/sensor/sweepRecognizer.js';
import {
  generatePureTiltSamples,
  generateRealisticSweepSamples,
  generateStationarySamples,
} from '../src/sensor/syntheticTraces.js';
import type { MotionSample } from '../src/sensor/types.js';
import { GESTURE_ASSIGNMENT_ORDER } from '../src/shared/constants.js';
import type { GestureId } from '../src/shared/types.js';

function calibrateRecognizer(
  gestureId: GestureId,
  includeLinearSensor = true,
  sampleRateHz = 60,
): PhysicalSweepRecognizer {
  const calibrator = new StationaryCalibrator();
  const stat = generateStationarySamples(1000, 800, sampleRateHz, includeLinearSensor, 55, 3);
  stat.forEach((s) => calibrator.pushSample(s));
  const cal = calibrator.finalize(0);
  expect(cal.validated).toBe(true);

  const rec = new PhysicalSweepRecognizer(gestureId);
  rec.setCalibration(cal);
  return rec;
}

describe('Section 14.1 — Local Physical-Sweep Recognizer Invariants', () => {
  it('rejects stationary phone with button pressed (no stroke)', () => {
    const rec = calibrateRecognizer('left_to_right');
    rec.beginAttempt(2000, { beta: 55, gamma: 3 });

    const stillSamples = generateStationarySamples(2016, 650, 60, true, 55, 3);
    let emitted = 0;
    for (const s of stillSamples) {
      const step = rec.pushSample(s);
      if (step.justLatchedSuccess) emitted += 1;
    }
    const rel = rec.releaseAttempt(2700);
    if (rel.justLatchedSuccess) emitted += 1;

    expect(emitted).toBe(0);
    expect(rel.rejectionCode).toBe('STATIONARY_NO_MOTION');
  });

  it('rejects quick tap without a sweep', () => {
    const rec = calibrateRecognizer('left_to_right');
    rec.beginAttempt(3000, { beta: 55, gamma: 3 });

    const brief = generateStationarySamples(3016, 80, 60, true, 55, 3);
    brief.forEach((s) => rec.pushSample(s));

    const rel = rec.releaseAttempt(3100);
    expect(rel.justLatchedSuccess).toBe(false);
    expect(rel.rejectionCode).toBe('TOO_SHORT_TAP');
  });

  it('recognizes all 6 assigned directions (cardinal & diagonal) with both linearAccel and gravity-removal fallback', () => {
    for (const includeLinear of [true, false]) {
      for (const gestureId of GESTURE_ASSIGNMENT_ORDER) {
        const rec = calibrateRecognizer(gestureId, includeLinear);
        rec.beginAttempt(4000, { beta: 55, gamma: 3 });

        const sweep = generateRealisticSweepSamples(gestureId, {
          startTimestampMs: 4016,
          includeLinearSensor: includeLinear,
          angleOffsetDeg: 14, // natural human grip/angle imperfection within tolerance
        });

        let candidates = 0;
        for (const s of sweep) {
          const step = rec.pushSample(s);
          if (step.justLatchedSuccess) candidates += 1;
        }
        const rel = rec.releaseAttempt(4700);
        if (rel.justLatchedSuccess) candidates += 1;

        expect(candidates).toBe(1);
      }
    }
  });

  it('rejects opposite-direction sweep despite its positive braking lobe pointing in desired direction', () => {
    for (const gestureId of GESTURE_ASSIGNMENT_ORDER) {
      const rec = calibrateRecognizer(gestureId, false);
      rec.beginAttempt(5000, { beta: 55, gamma: 3 });

      // 180 deg opposite sweep: initial lobe is -desired, second half braking lobe is +desired!
      const oppositeSweep = generateRealisticSweepSamples(gestureId, {
        startTimestampMs: 5016,
        angleOffsetDeg: 180,
        includeLinearSensor: false,
      });

      let accepted = 0;
      let sawWrongDir = false;
      for (const s of oppositeSweep) {
        const step = rec.pushSample(s);
        if (step.justLatchedSuccess) accepted += 1;
        if (step.rejectionCode === 'WRONG_DIRECTION') sawWrongDir = true;
      }
      const rel = rec.releaseAttempt(5700);
      if (rel.justLatchedSuccess) accepted += 1;

      expect(accepted).toBe(0);
      expect(sawWrongDir).toBe(true);
    }
  });

  it('rejects perpendicular movement on diagonal assigned sweeps', () => {
    const rec = calibrateRecognizer('upper_left_to_lower_right', true);
    rec.beginAttempt(6000, { beta: 55, gamma: 3 });

    const perpSweep = generateRealisticSweepSamples('upper_left_to_lower_right', {
      startTimestampMs: 6016,
      angleOffsetDeg: 90,
      includeLinearSensor: true,
    });

    let accepted = 0;
    for (const s of perpSweep) {
      if (rec.pushSample(s).justLatchedSuccess) accepted += 1;
    }
    if (rec.releaseAttempt(6700).justLatchedSuccess) accepted += 1;
    expect(accepted).toBe(0);
  });

  it('ignores return movement while button is released', () => {
    const rec = calibrateRecognizer('left_to_right', true);

    // Working stroke while held
    rec.beginAttempt(7000, { beta: 55, gamma: 3 });
    const forward = generateRealisticSweepSamples('left_to_right', { startTimestampMs: 7016 });
    let heldCount = 0;
    forward.forEach((s) => {
      if (rec.pushSample(s).justLatchedSuccess) heldCount += 1;
    });
    rec.releaseAttempt(7650);
    expect(heldCount).toBe(1);

    // Return movement (both opposite AND accidentally matching direction) while released
    const returnBack = generateRealisticSweepSamples('right_to_left', { startTimestampMs: 7700 });
    const extraWhileReleased = generateRealisticSweepSamples('left_to_right', { startTimestampMs: 8300 });
    let releasedStrokes = 0;
    for (const s of [...returnBack, ...extraWhileReleased]) {
      if (rec.pushSample(s).justLatchedSuccess) releasedStrokes += 1;
    }
    expect(releasedStrokes).toBe(0);
  });

  it('awards at most one stroke per button press even if player sweeps three times before releasing', () => {
    const rec = calibrateRecognizer('left_to_right', true);
    rec.beginAttempt(9000, { beta: 55, gamma: 3 });

    const s1 = generateRealisticSweepSamples('left_to_right', { startTimestampMs: 9020 });
    const s2 = generateRealisticSweepSamples('left_to_right', { startTimestampMs: 9700 });
    const s3 = generateRealisticSweepSamples('left_to_right', { startTimestampMs: 10400 });

    let count = 0;
    for (const s of [...s1, ...s2, ...s3]) {
      if (rec.pushSample(s).justLatchedSuccess) count += 1;
    }
    if (rec.releaseAttempt(11100).justLatchedSuccess) count += 1;

    expect(count).toBe(1);
  });

  it('recovers cleanly after mid-attempt cancel so the next press succeeds', () => {
    const rec = calibrateRecognizer('top_to_bottom', true);
    rec.beginAttempt(12000, { beta: 55, gamma: 3 });
    const partial = generateRealisticSweepSamples('top_to_bottom', { startTimestampMs: 12020 }).slice(0, 8);
    partial.forEach((s) => rec.pushSample(s));

    const canceled = rec.cancelAttempt('Pointer lost');
    expect(canceled.state).toBe('released');
    expect(canceled.rejectionCode).toBe('CANCELED_INTERRUPTED');

    // Next press works normally
    rec.beginAttempt(12500, { beta: 55, gamma: 3 });
    const nextFull = generateRealisticSweepSamples('top_to_bottom', { startTimestampMs: 12520 });
    let hits = 0;
    nextFull.forEach((s) => {
      if (rec.pushSample(s).justLatchedSuccess) hits += 1;
    });
    expect(hits).toBe(1);
  });

  it('rejects pure wrist orientation tilt / gravity rotation without linear sweep', () => {
    const rec = calibrateRecognizer('left_to_right', false); // Gravity-including fallback path!
    rec.beginAttempt(14000, { beta: 55, gamma: 0 });

    const tiltOnly = generatePureTiltSamples(14016, 550, 60, false, 55, 0, 32);
    let hits = 0;
    for (const s of tiltOnly) {
      if (rec.pushSample(s).justLatchedSuccess) hits += 1;
    }
    if (rec.releaseAttempt(14600).justLatchedSuccess) hits += 1;
    expect(hits).toBe(0);
  });

  it('ignores button-press / haptic spike inside the initial transient window', () => {
    const rec = calibrateRecognizer('left_to_right', true);
    rec.beginAttempt(15000, { beta: 55, gamma: 3 });

    const gVec = computeW3CGravityReaction(55, 3, 1);
    const transientSamples: MotionSample[] = [
      {
        timestampMs: 15008,
        linearAccel: { x: 8.5, y: 0, z: 2.0 },
        accelIncludingGravity: { x: gVec.x + 8.5, y: gVec.y, z: gVec.z + 2.0 },
        rotationRateDegPerSec: { alpha: 0, beta: 0, gamma: 0 },
        orientationDeg: { alpha: 0, beta: 55, gamma: 3 },
      },
      {
        timestampMs: 15020,
        linearAccel: { x: 6.2, y: 0, z: -1.5 },
        accelIncludingGravity: { x: gVec.x + 6.2, y: gVec.y, z: gVec.z - 1.5 },
        rotationRateDegPerSec: { alpha: 0, beta: 0, gamma: 0 },
        orientationDeg: { alpha: 0, beta: 55, gamma: 3 },
      },
      ...generateStationarySamples(15040, 450, 60, true, 55, 3),
    ];

    let hits = 0;
    transientSamples.forEach((s) => {
      if (rec.pushSample(s).justLatchedSuccess) hits += 1;
    });
    if (rec.releaseAttempt(15520).justLatchedSuccess) hits += 1;
    expect(hits).toBe(0);
  });

  it('produces consistent recognition across 30 Hz, 60 Hz, and 120 Hz sample rates and timing gaps', () => {
    const impulses: number[] = [];
    for (const rateHz of [30, 60, 120]) {
      const rec = calibrateRecognizer('left_to_right', true, rateHz);
      rec.beginAttempt(16000, { beta: 55, gamma: 3 });

      // Drop one sample mid-lobe to simulate browser event jitter gap
      const rawSweep = generateRealisticSweepSamples('left_to_right', {
        startTimestampMs: 16020,
        sampleRateHz: rateHz,
      }).filter((_, idx) => idx !== 5);

      let foundImpulse = 0;
      for (const s of rawSweep) {
        const res = rec.pushSample(s);
        if (res.justLatchedSuccess && res.strokeCandidate) {
          foundImpulse = res.strokeCandidate.forwardImpulseMps;
        }
      }
      const rel = rec.releaseAttempt(16800);
      if (rel.justLatchedSuccess && rel.strokeCandidate) {
        foundImpulse = rel.strokeCandidate.forwardImpulseMps;
      }

      expect(foundImpulse).toBeGreaterThan(0.35);
      impulses.push(foundImpulse);
    }

    // 30Hz, 60Hz, and 120Hz time-integrated impulses stay closely matched (no frame-count advantage)
    const minImp = Math.min(...impulses);
    const maxImp = Math.max(...impulses);
    expect(maxImp - minImp).toBeLessThan(0.18);
  });

  it('recalibration preserves assigned gesture, increments calibration version, and cancels active hold', () => {
    const calibrator = new StationaryCalibrator();
    generateStationarySamples(1000, 800, 60).forEach((s) => calibrator.pushSample(s));
    const cal1 = calibrator.finalize(0);

    const rec = new PhysicalSweepRecognizer('bottom_to_top');
    rec.setCalibration(cal1);
    rec.beginAttempt(2000, { beta: 55, gamma: 3 });
    expect(rec.getState()).toBe('armed');

    calibrator.resetSamples();
    generateStationarySamples(3000, 800, 60).forEach((s) => calibrator.pushSample(s));
    const cal2 = calibrator.finalize(cal1.version);

    rec.setCalibration(cal2);
    expect(rec.getGesture()).toBe('bottom_to_top');
    expect(rec.getCalibration()?.version).toBe(cal1.version + 1);
    expect(rec.getState()).toBe('released');
  });

  it('automatically detects and normalizes iOS CoreMotion (-1) inverted acceleration signs (with and without DeviceOrientationEvent)', () => {
    const negateToIosCoreMotion = (s: MotionSample, stripOrientation: boolean): MotionSample => ({
      ...s,
      linearAccel: s.linearAccel
        ? { x: -s.linearAccel.x, y: -s.linearAccel.y, z: -s.linearAccel.z }
        : null,
      accelIncludingGravity: s.accelIncludingGravity
        ? {
            x: -s.accelIncludingGravity.x,
            y: -s.accelIncludingGravity.y,
            z: -s.accelIncludingGravity.z,
          }
        : null,
      orientationDeg: stripOrientation ? null : s.orientationDeg,
    });

    for (const includeLinear of [true, false]) {
      for (const stripOrientation of [false, true]) {
        for (const gestureId of GESTURE_ASSIGNMENT_ORDER) {
          const calibrator = new StationaryCalibrator();
          generateStationarySamples(1000, 800, 60, includeLinear, 50, 2)
            .map((s) => negateToIosCoreMotion(s, stripOrientation))
            .forEach((s) => calibrator.pushSample(s));

          const cal = calibrator.finalize(0);
          expect(cal.validated).toBe(true);
          expect(cal.gravitySignConvention).toBe(-1);

          const rec = new PhysicalSweepRecognizer(gestureId);
          rec.setCalibration(cal);

          // 1. Correct sweep on iOS (raw CoreMotion axes negated) -> MUST accept!
          rec.beginAttempt(2000, stripOrientation ? null : { beta: 50, gamma: 2 });
          const iosCorrectSweep = generateRealisticSweepSamples(gestureId, {
            startTimestampMs: 2016,
            includeLinearSensor: includeLinear,
            betaDeg: 50,
            gammaDeg: 2,
          }).map((s) => negateToIosCoreMotion(s, stripOrientation));

          let accepted = 0;
          iosCorrectSweep.forEach((s) => {
            if (rec.pushSample(s).justLatchedSuccess) accepted += 1;
          });
          if (rec.releaseAttempt(2700).justLatchedSuccess) accepted += 1;
          expect(accepted).toBe(1);

          // 2. Opposite sweep on iOS -> MUST still reject (no braking-lobe false positive)!
          rec.beginAttempt(3000, stripOrientation ? null : { beta: 50, gamma: 2 });
          const iosOppositeSweep = generateRealisticSweepSamples(gestureId, {
            startTimestampMs: 3016,
            angleOffsetDeg: 180,
            includeLinearSensor: includeLinear,
            betaDeg: 50,
            gammaDeg: 2,
          }).map((s) => negateToIosCoreMotion(s, stripOrientation));

          let falseAccepts = 0;
          iosOppositeSweep.forEach((s) => {
            if (rec.pushSample(s).justLatchedSuccess) falseAccepts += 1;
          });
          if (rec.releaseAttempt(3700).justLatchedSuccess) falseAccepts += 1;
          expect(falseAccepts).toBe(0);
        }
      }
    }
  });
});
