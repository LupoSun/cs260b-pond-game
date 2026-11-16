import React, { useEffect, useRef, useState } from 'react';
import { StationaryCalibrator } from '../../sensor/gravity.js';
import { BrowserSensorManager, type SensorCapabilityReport } from '../../sensor/sensorManager.js';
import { PhysicalSweepRecognizer } from '../../sensor/sweepRecognizer.js';
import {
  generatePureTiltSamples,
  generateRealisticSweepSamples,
  generateStationarySamples,
} from '../../sensor/syntheticTraces.js';
import { TiltFallbackRecognizer } from '../../sensor/tiltRecognizer.js';
import type {
  ExtendedCalibrationData,
  ProcessedMotionSample,
  RecognizedStrokeCandidate,
} from '../../sensor/types.js';
import { GESTURE_ASSIGNMENT_ORDER, GESTURE_SPECS } from '../../shared/constants.js';
import type { AttemptMachineState, GestureId, RecognitionRejectionCode } from '../../shared/types.js';
import { GestureDemoBadge } from '../components/GestureDemoBadge.js';

/**
 * Gate A — Standalone Physical-Phone Sensor Laboratory (/lab, Section 15).
 * Validates capability detection, stationary calibration, hold-sweep-release state machine,
 * live raw/gravity-compensated oscilloscope traces, and rejection diagnostics.
 */
export const SensorLabView: React.FC = () => {
  const [gestureId, setGestureId] = useState<GestureId>('left_to_right');
  const [recognizerKind, setRecognizerKind] = useState<'physical_sweep' | 'tilt'>('physical_sweep');
  const [capReport, setCapReport] = useState<SensorCapabilityReport | null>(null);
  const [calibrating, setCalibrating] = useState(false);
  const [calibration, setCalibration] = useState<ExtendedCalibrationData | null>(null);

  const [machineState, setMachineState] = useState<AttemptMachineState>('released');
  const [reasonText, setReasonText] = useState('Enable sensors or run synthetic trace below, then calibrate.');
  const [rejectionCode, setRejectionCode] = useState<RecognitionRejectionCode>('NONE');
  const [progress, setProgress] = useState(0);
  const [lastCandidate, setLastCandidate] = useState<RecognizedStrokeCandidate | null>(null);

  const [acceptedCount, setAcceptedCount] = useState(0);
  const [rejectedCount, setRejectedCount] = useState(0);
  const [strokesThisPress, setStrokesThisPress] = useState(0);
  const [maxStrokesPerPressObserved, setMaxStrokesPerPressObserved] = useState(0);

  const sensorMgrRef = useRef<BrowserSensorManager | null>(null);
  const calibratorRef = useRef(new StationaryCalibrator());
  const sweepRecRef = useRef(new PhysicalSweepRecognizer('left_to_right'));
  const tiltRecRef = useRef(new TiltFallbackRecognizer('left_to_right'));
  const traceBufferRef = useRef<ProcessedMotionSample[]>([]);
  const traceCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const isCalibratingRef = useRef(false);
  const recognizerKindRef = useRef(recognizerKind);
  recognizerKindRef.current = recognizerKind;
  const strokesInCurrentPressRef = useRef(0);

  const showDevTools =
    typeof window !== 'undefined' &&
    (window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1' ||
      new URLSearchParams(window.location.search).get('devSim') === '1');

  useEffect(() => {
    const mgr = new BrowserSensorManager();
    sensorMgrRef.current = mgr;

    const unsub = mgr.subscribe((sample) => {
      if (isCalibratingRef.current) {
        calibratorRef.current.pushSample(sample);
        return;
      }

      const step =
        recognizerKindRef.current === 'physical_sweep'
          ? sweepRecRef.current.pushSample(sample)
          : tiltRecRef.current.pushSample(sample);

      if (step.processedSample) {
        traceBufferRef.current.push(step.processedSample);
        if (traceBufferRef.current.length > 180) {
          traceBufferRef.current.shift();
        }
      }

      setMachineState(step.state);
      setProgress(step.progress);
      setReasonText(step.reasonText);
      setRejectionCode(step.rejectionCode);

      if (step.justLatchedSuccess && step.strokeCandidate) {
        strokesInCurrentPressRef.current += 1;
        setStrokesThisPress(strokesInCurrentPressRef.current);
        setMaxStrokesPerPressObserved((prev) => Math.max(prev, strokesInCurrentPressRef.current));
        setLastCandidate(step.strokeCandidate);
        setAcceptedCount((c) => c + 1);
      } else if (step.justLatchedFailure) {
        setRejectedCount((c) => c + 1);
      }
    });

    // Oscilloscope render loop
    let rafId = 0;
    const drawTrace = () => {
      const canvas = traceCanvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          const w = canvas.width;
          const h = canvas.height;
          ctx.fillStyle = '#092226';
          ctx.fillRect(0, 0, w, h);

          // Zero centerline & +/- 5 m/s^2 reference lines
          const midY = h / 2;
          const scaleY = (h * 0.42) / 8; // +/- 8 m/s^2 full scale

          ctx.strokeStyle = 'rgba(255,255,255,0.15)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(0, midY);
          ctx.lineTo(w, midY);
          ctx.stroke();

          const samples = traceBufferRef.current;
          if (samples.length > 1) {
            const plotChannel = (getter: (s: ProcessedMotionSample) => number, color: string) => {
              ctx.strokeStyle = color;
              ctx.lineWidth = 2;
              ctx.beginPath();
              samples.forEach((s, idx) => {
                const x = (idx / 179) * w;
                const y = Math.max(4, Math.min(h - 4, midY - getter(s) * scaleY));
                if (idx === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
              });
              ctx.stroke();
            };

            plotChannel((s) => s.screenX, '#4cc9f0'); // Screen +X (cyan)
            plotChannel((s) => s.screenY, '#ffd166'); // Screen +Y (gold)
            plotChannel((s) => s.magnitudeXY, '#3bf084'); // Magnitude XY (green)
          }
        }
      }
      rafId = window.requestAnimationFrame(drawTrace);
    };
    rafId = window.requestAnimationFrame(drawTrace);

    const onBlurOrHide = () => {
      sweepRecRef.current.cancelAttempt('Page lost focus');
      tiltRecRef.current.cancelAttempt('Page lost focus');
      setMachineState('released');
      setProgress(0);
    };
    window.addEventListener('blur', onBlurOrHide);
    document.addEventListener('visibilitychange', onBlurOrHide);

    return () => {
      unsub();
      mgr.stopListening();
      window.cancelAnimationFrame(rafId);
      window.removeEventListener('blur', onBlurOrHide);
      document.removeEventListener('visibilitychange', onBlurOrHide);
    };
  }, []);

  const handleSelectGesture = (next: GestureId) => {
    setGestureId(next);
    sweepRecRef.current.setGesture(next);
    tiltRecRef.current.setGesture(next);
  };

  const handleEnableSensors = async () => {
    if (!sensorMgrRef.current) return;
    const report = await sensorMgrRef.current.enableAndCheckCapabilities(650);
    setCapReport(report);
    setReasonText(report.summaryMessage);
  };

  const handleCalibrateReal = () => {
    calibratorRef.current.resetSamples();
    isCalibratingRef.current = true;
    setCalibrating(true);
    setReasonText('Hold phone comfortably steady for 0.8s...');

    window.setTimeout(() => {
      isCalibratingRef.current = false;
      setCalibrating(false);
      const cal = calibratorRef.current.finalize(calibration?.version ?? 0);
      setCalibration(cal);
      sweepRecRef.current.setCalibration(cal);
      setReasonText(
        cal.validated
          ? `Calibrated v${cal.version} (noise RMS ${cal.stationaryNoiseRms.toFixed(2)} m/s², onset ${cal.onsetThreshold.toFixed(2)} m/s²)`
          : 'Insufficient or unsteady sensor samples during calibration.',
      );
    }, 800);
  };

  const beginHold = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    strokesInCurrentPressRef.current = 0;
    setStrokesThisPress(0);
    const ori = sensorMgrRef.current?.getLatestOrientation() ?? null;
    const step =
      recognizerKind === 'physical_sweep'
        ? sweepRecRef.current.beginAttempt(performance.now(), ori)
        : tiltRecRef.current.beginAttempt(performance.now(), ori);
    setMachineState(step.state);
    setReasonText(step.reasonText);
    setProgress(step.progress);
  };

  const endHold = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const step =
      recognizerKind === 'physical_sweep'
        ? sweepRecRef.current.releaseAttempt(performance.now())
        : tiltRecRef.current.releaseAttempt();
    setMachineState(step.state);
    setReasonText(step.reasonText);
    setRejectionCode(step.rejectionCode);
    setProgress(0);
    if (step.justLatchedSuccess && step.strokeCandidate) {
      strokesInCurrentPressRef.current += 1;
      setStrokesThisPress(strokesInCurrentPressRef.current);
      setMaxStrokesPerPressObserved((prev) => Math.max(prev, strokesInCurrentPressRef.current));
      setLastCandidate(step.strokeCandidate);
      setAcceptedCount((c) => c + 1);
    } else if (step.justLatchedFailure) {
      setRejectedCount((c) => c + 1);
    }
  };

  // Explicit Development Synthetic Trace Injection (for desktop verification of Gate A diagnostics)
  const runDevSyntheticScenario = (kind: 'calibrate' | 'correct' | 'opposite' | 'pure_tilt') => {
    const mgr = sensorMgrRef.current;
    if (!mgr) return;
    const baseNow = performance.now();

    if (kind === 'calibrate') {
      calibratorRef.current.resetSamples();
      const samples = generateStationarySamples(baseNow, 800, 60, false);
      samples.forEach((s) => calibratorRef.current.pushSample(s));
      const cal = calibratorRef.current.finalize(calibration?.version ?? 0);
      setCalibration(cal);
      sweepRecRef.current.setCalibration(cal);
      setReasonText(`[DEV SYNTHETIC] Calibrated v${cal.version} (gravity-compensated fallback mode).`);
      return;
    }

    strokesInCurrentPressRef.current = 0;
    setStrokesThisPress(0);
    sweepRecRef.current.beginAttempt(baseNow, { beta: 55, gamma: 3 });

    const samples =
      kind === 'correct'
        ? generateRealisticSweepSamples(gestureId, {
            startTimestampMs: baseNow + 16,
            angleOffsetDeg: 0,
            includeLinearSensor: false,
          })
        : kind === 'opposite'
          ? generateRealisticSweepSamples(gestureId, {
              startTimestampMs: baseNow + 16,
              angleOffsetDeg: 180,
              includeLinearSensor: false,
            })
          : generatePureTiltSamples(baseNow + 16, 500, 60, false, 55, 3, 30);

    samples.forEach((s) => mgr.injectDevSyntheticSample(s));
    const endTs = samples[samples.length - 1].timestampMs + 20;
    const rel = sweepRecRef.current.releaseAttempt(endTs);
    setMachineState(rel.state);
    setProgress(0);
  };

  return (
    <main className="control-shell" style={{ maxWidth: 680 }}>
      <header className="play-topbar">
        <div>
          <strong>Gate A · Phone Sensor Laboratory</strong>
          <div style={{ fontSize: '0.8rem', color: 'var(--ink-secondary)' }}>
            Local physical-sweep &amp; calibration verifier (no server propulsion)
          </div>
        </div>
        <a href="/play" className="btn-subtle btn-xs">
          Open /play
        </a>
      </header>

      <section className="control-panel">
        <h2>1. Browser Sensor Capability &amp; Calibration</h2>
        <div className="btn-row">
          <button type="button" className="btn-primary" onClick={() => void handleEnableSensors()}>
            Enable &amp; Check Sensors
          </button>
          <button
            type="button"
            className="btn-secondary"
            disabled={calibrating}
            onClick={handleCalibrateReal}
          >
            {calibrating ? 'Calibrating (hold steady)...' : 'Capture Stationary Calibration (0.8s)'}
          </button>
        </div>

        {capReport && (
          <div style={{ fontSize: '0.84rem', color: 'var(--ink-secondary)' }}>
            Status: <strong>{capReport.status}</strong> · Rate: <strong>{capReport.measuredRateHz} Hz</strong> ·
            HTTPS: <strong>{String(capReport.isSecureContext)}</strong> · LinearAccel:{' '}
            <strong>{String(capReport.hasLinearAcceleration)}</strong> · AccelIncG:{' '}
            <strong>{String(capReport.hasAccelIncludingGravity)}</strong>
          </div>
        )}

        {calibration && (
          <div style={{ fontSize: '0.84rem', color: 'var(--ink-secondary)' }}>
            Cal v{calibration.version} ({calibration.validated ? 'Validated' : 'Unvalidated'}) ·
            AxisSign:{' '}
            <strong>
              {calibration.gravitySignConvention === -1
                ? '-1 (iOS CoreMotion → W3C normalized)'
                : '+1 (W3C/Android)'}
            </strong>{' '}
            · Noise RMS: <strong>{calibration.stationaryNoiseRms.toFixed(3)} m/s²</strong> · Onset:{' '}
            <strong>{calibration.onsetThreshold.toFixed(2)} m/s²</strong> · Min Peak:{' '}
            <strong>{calibration.minPeakSignal.toFixed(2)} m/s²</strong>
          </div>
        )}
      </section>

      <section className="control-panel">
        <h2>2. Assigned Gesture &amp; Recognizer</h2>
        <div className="btn-row">
          <select
            className="field-select"
            value={gestureId}
            onChange={(e) => handleSelectGesture(e.target.value as GestureId)}
            aria-label="Assigned movement"
          >
            {GESTURE_ASSIGNMENT_ORDER.map((gid) => (
              <option key={gid} value={gid}>
                {GESTURE_SPECS[gid].shortLabel} — {GESTURE_SPECS[gid].instruction}
              </option>
            ))}
          </select>

          <select
            className="field-select"
            value={recognizerKind}
            onChange={(e) => setRecognizerKind(e.target.value as 'physical_sweep' | 'tilt')}
            aria-label="Recognizer mode"
          >
            <option value="physical_sweep">Primary: Physical Sweep</option>
            <option value="tilt">Explicit Fallback: Directional Tilt</option>
          </select>
        </div>

        <GestureDemoBadge gestureId={gestureId} animate={true} compact />

        <div
          role="button"
          tabIndex={0}
          className={`paddle-hold-pad ${
            machineState === 'recognized_locked'
              ? 'is-accepted'
              : machineState !== 'released'
                ? 'is-held'
                : ''
          }`}
          onContextMenu={(e) => e.preventDefault()}
          onPointerDown={beginHold}
          onPointerUp={endHold}
          onPointerCancel={endHold}
          onLostPointerCapture={() => {
            sweepRecRef.current.cancelAttempt('Pointer capture lost');
            setMachineState('released');
            setProgress(0);
          }}
        >
          <div className="paddle-hold-title">
            {machineState === 'released'
              ? 'Hold to Capture Sweep'
              : machineState === 'recognized_locked'
                ? 'Stroke Latched ✓ (Release Now)'
                : `State: ${machineState}`}
          </div>
          <div className="paddle-hold-hint">{reasonText}</div>
          <div className="paddle-progress-track">
            <div className="paddle-progress-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        </div>
      </section>

      <section className="control-panel">
        <h2>3. Live Processed Screen-Plane Trace &amp; Trial Counters</h2>
        <canvas
          ref={traceCanvasRef}
          width={560}
          height={130}
          style={{ width: '100%', borderRadius: 8, border: '3px solid var(--border-strong)' }}
        />
        <div style={{ fontSize: '0.8rem', color: 'var(--ink-secondary)' }}>
          Cyan: screenX (+right) · Gold: screenY (+up) · Green: |XY| linear magnitude (±8 m/s² scale)
        </div>

        <div className="btn-row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <span>
            Accepted: <strong>{acceptedCount}</strong> · Rejected: <strong>{rejectedCount}</strong> ·
            This Press: <strong>{strokesThisPress}</strong> · Max/Press:{' '}
            <strong>{maxStrokesPerPressObserved}</strong> (must be ≤ 1) · Last Rejection:{' '}
            <strong>{rejectionCode}</strong>
          </span>
          <button
            type="button"
            className="btn-subtle btn-xs"
            onClick={() => {
              setAcceptedCount(0);
              setRejectedCount(0);
              setMaxStrokesPerPressObserved(0);
              setLastCandidate(null);
            }}
          >
            Clear Counters
          </button>
        </div>

        {lastCandidate && (
          <div style={{ fontSize: '0.83rem', color: 'var(--ink-secondary)' }}>
            Last Accepted Candidate: <code>{lastCandidate.strokeId}</code> · Duration:{' '}
            {lastCandidate.durationMs} ms · Peak: {lastCandidate.peakSignalMps2} m/s² · Impulse:{' '}
            {lastCandidate.forwardImpulseMps} m/s · Angle Err: {lastCandidate.angleErrorDeg}° ·
            Consistency: {lastCandidate.consistency}
          </div>
        )}
      </section>

      {showDevTools && (
        <section className="control-panel" style={{ borderColor: 'var(--accent-sun)' }}>
          <h2>[DEV SYNTHETIC TRACE VERIFIER — NOT PHYSICAL PHONE PROOF]</h2>
          <div className="btn-row">
            <button
              type="button"
              className="btn-subtle btn-xs"
              onClick={() => runDevSyntheticScenario('calibrate')}
            >
              1. Sim Stationary Calibrate
            </button>
            <button
              type="button"
              className="btn-subtle btn-xs"
              onClick={() => runDevSyntheticScenario('correct')}
            >
              2. Sim Assigned Sweep (Expect Accept)
            </button>
            <button
              type="button"
              className="btn-subtle btn-xs"
              onClick={() => runDevSyntheticScenario('opposite')}
            >
              3. Sim Opposite Sweep w/ Braking (Expect Reject)
            </button>
            <button
              type="button"
              className="btn-subtle btn-xs"
              onClick={() => runDevSyntheticScenario('pure_tilt')}
            >
              4. Sim Pure Wrist Tilt (Expect Reject)
            </button>
          </div>
        </section>
      )}
    </main>
  );
};
