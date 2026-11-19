import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { detectPlatformDefaultAccelSign, StationaryCalibrator } from '../../sensor/gravity.js';
import { BrowserSensorManager, type SensorCapabilityReport } from '../../sensor/sensorManager.js';
import { PhysicalSweepRecognizer } from '../../sensor/sweepRecognizer.js';
import { generateRealisticSweepSamples, generateStationarySamples } from '../../sensor/syntheticTraces.js';
import { TiltFallbackRecognizer } from '../../sensor/tiltRecognizer.js';
import type { ExtendedCalibrationData, RecognizedStrokeCandidate } from '../../sensor/types.js';
import { GAME_DEFAULTS, GESTURE_SPECS, RECOGNIZER_DEFAULTS, describePhase } from '../../shared/constants.js';
import { PLAYER_NAME_MAX_LENGTH, sanitizePlayerName } from '../../shared/playerName.js';
import { SweepSteps, type SweepStage } from '../components/SweepSteps.js';
import type {
  AckResponse,
  CalibrationSummary,
  InputMethod,
  PlayerPrivateSeat,
  SessionPublicSnapshot,
  StrokeAcceptedBroadcast,
  StrokeCompletePayload,
} from '../../shared/types.js';
import { ComicBurst } from '../components/ComicBurst.js';
import { CreatureCardCanvas } from '../components/CreatureCardCanvas.js';
import { GestureDemoBadge } from '../components/GestureDemoBadge.js';
import { FeedbackController } from '../feedback.js';
import type { TransientVisualEffects } from '../pondRenderer.js';
import { createPondSocket } from '../socketClient.js';

const RESUME_STORAGE_KEY = 'cs260b_pond_seat_v1';

type OnboardStep = 'join' | 'sensors' | 'calibrate' | 'practice' | 'controller';

interface StoredResume {
  sessionId: string;
  resumeToken: string;
  savedCalibration?: ExtendedCalibrationData;
}

/** Onomatopoeia shown in the starburst over the pad each time a stroke is accepted. */
const POP_WORDS = ['SPLASH!', 'SWOOSH!', 'POW!', 'ZOOM!'];
const SETUP_STEP_LABELS = ['Enable motion', 'Calibrate', 'Practice'];

/** Three-dot tracker for the sensors -> calibrate -> practice onboarding steps. */
const SetupStepTrack: React.FC<{ current: 1 | 2 | 3; showLabel?: boolean }> = ({
  current,
  showLabel = true,
}) => (
  <div className="step-track" aria-label={`Setup step ${current} of 3: ${SETUP_STEP_LABELS[current - 1]}`}>
    {[1, 2, 3].map((n) => (
      <React.Fragment key={n}>
        {n > 1 && <span className="step-track-line" aria-hidden="true" />}
        <span
          className={`step-dot ${n < current ? 'is-done' : n === current ? 'is-current' : ''}`}
          aria-hidden="true"
        >
          {n < current ? '✓' : n}
        </span>
      </React.Fragment>
    ))}
    {showLabel && <span style={{ marginLeft: '0.3rem' }}>{SETUP_STEP_LABELS[current - 1]}</span>}
  </div>
);

/** iPhone and iPad only: the system offers "Undo Typing" when the device is shaken. */
function isAppleTouchDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  return (
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

const AcceptedPop: React.FC<{ seq: number }> = ({ seq }) => (
  <span className="pad-pop" aria-hidden="true">
    <ComicBurst fill="#ffd91a" seed={(seq % 4) + 1} className="burst-pop">
      <span className="comic-word" style={{ '--word-fill': '#dc1f26' } as React.CSSProperties}>
        {POP_WORDS[seq % POP_WORDS.length]}
      </span>
    </ComicBurst>
  </span>
);

export const PlayView: React.FC = () => {
  const [connected, setConnected] = useState(false);
  const [snapshot, setSnapshot] = useState<SessionPublicSnapshot | null>(null);
  const [seat, setSeat] = useState<PlayerPrivateSeat | null>(null);
  const [step, setStep] = useState<OnboardStep>('join');
  const [superseded, setSuperseded] = useState(false);

  // Join form
  const [teamInput, setTeamInput] = useState('');
  const [nameInput, setNameInput] = useState('');
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);

  // Onboarding sensor / calibration / practice state
  const [capReport, setCapReport] = useState<SensorCapabilityReport | null>(null);
  const [checkingSensors, setCheckingSensors] = useState(false);
  const [calibrating, setCalibrating] = useState(false);
  const [localCal, setLocalCal] = useState<ExtendedCalibrationData | null>(null);
  const [practiceSuccesses, setPracticeSuccesses] = useState(0);
  const practicePeaksRef = useRef<number[]>([]);

  // Controller state
  const [inputMethod, setInputMethod] = useState<InputMethod>('physical_sweep');
  const [held, setHeld] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusKind, setStatusKind] = useState<'neutral' | 'local' | 'accepted' | 'warn'>('neutral');
  const [statusMessage, setStatusMessage] = useState('Press the pad, move along your arrow, release.');
  const [animateDemo, setAnimateDemo] = useState(true);
  const [muted, setMuted] = useState(false);
  const [hapticsOn, setHapticsOn] = useState(true);

  // Presentation only: re-keys the accepted-stroke starburst so it pops once per accepted stroke
  const [acceptedPopSeq, setAcceptedPopSeq] = useState(0);
  useEffect(() => {
    if (statusKind === 'accepted') setAcceptedPopSeq((s) => s + 1);
  }, [statusKind]);

  const socketRef = useRef<Socket | null>(null);
  const sensorMgrRef = useRef(new BrowserSensorManager());
  const calibratorRef = useRef(new StationaryCalibrator());
  const sweepRecRef = useRef(new PhysicalSweepRecognizer('left_to_right'));
  const tiltRecRef = useRef(new TiltFallbackRecognizer('left_to_right'));
  const feedbackRef = useRef(new FeedbackController());
  const effectsRef = useRef<TransientVisualEffects>({
    limbAcceptedFlashAtMs: new Map(),
    itemPops: new Map(),
  });

  // Mutable refs for high-rate sensor callback without stale closures
  const isCalibratingRef = useRef(false);
  const stepRef = useRef<OnboardStep>(step);
  stepRef.current = step;
  const seatRef = useRef<PlayerPrivateSeat | null>(seat);
  seatRef.current = seat;
  const snapRef = useRef<SessionPublicSnapshot | null>(snapshot);
  snapRef.current = snapshot;
  const inputMethodRef = useRef<InputMethod>(inputMethod);
  inputMethodRef.current = inputMethod;
  const heldRef = useRef(false);
  const lastPreviewSentMsRef = useRef(0);
  const touchStartPtRef = useRef<{ x: number; y: number; atMs: number; attemptId: string; attemptSeq: number; latched: boolean } | null>(null);
  const touchSeqCounterRef = useRef(0);
  const lastMeasuredRttMsRef = useRef<number | undefined>(undefined);
  const estimatedClockOffsetMsRef = useRef<number | undefined>(undefined);

  const cancelActiveHold = useCallback((reason: string) => {
    const wasHeld = heldRef.current;
    heldRef.current = false;
    touchStartPtRef.current = null;
    setHeld(false);
    setProgress(0);

    const meta =
      inputMethodRef.current === 'tilt'
        ? tiltRecRef.current.getAttemptMeta()
        : sweepRecRef.current.getAttemptMeta();
    sweepRecRef.current.cancelAttempt(reason);
    tiltRecRef.current.cancelAttempt(reason);

    if (wasHeld) {
      setStatusKind('warn');
      setStatusMessage(reason);
      const sock = socketRef.current;
      const curSeat = seatRef.current;
      const curSnap = snapRef.current;
      if (sock?.connected && curSeat && curSnap && meta.attemptId) {
        sock.emit('input.cancel', {
          attemptId: meta.attemptId,
          attemptSeq: meta.attemptSeq,
          sessionId: curSnap.sessionId,
          roundId: curSnap.round.roundId,
          inputEpoch: curSnap.inputEpoch,
          connectionGeneration: curSeat.connectionGeneration,
          reason,
        });
      }
    }
  }, []);

  /**
   * True when this phone's presses, previews, and strokes should reach the server.
   * The controller always does. The onboarding practice step does too while Training is running,
   * so practice sweeps animate the limb on the classroom grid; outside Training it stays local.
   */
  const mirrorsInputToServer = useCallback((): boolean => {
    if (stepRef.current === 'controller') return true;
    const curSnap = snapRef.current;
    return (
      stepRef.current === 'practice' &&
      Boolean(seatRef.current?.calibrated) &&
      curSnap?.phase === 'training' &&
      curSnap.runStatus === 'running'
    );
  }, []);

  /** `quiet` leaves the status banner alone: the practice step reports its own local result. */
  const submitStrokeToServer = useCallback((candidate: RecognizedStrokeCandidate, quiet = false) => {
    const sock = socketRef.current;
    const curSeat = seatRef.current;
    const curSnap = snapRef.current;
    const report = (kind: 'local' | 'accepted' | 'warn', message: string) => {
      if (quiet) return;
      setStatusKind(kind);
      setStatusMessage(message);
    };

    // Never queue strokes while offline (Section 12.5)
    if (!sock || !sock.connected || !curSeat || !curSnap) {
      report('warn', 'Offline: stroke not queued. Wait for connection.');
      return;
    }

    if (curSnap.phase === 'lobby' || curSnap.runStatus !== 'running') {
      report('local', 'Motion recognized locally (round not active yet).');
      return;
    }

    report('local', 'Motion recognized · confirming...');

    const payload: StrokeCompletePayload = {
      strokeId: candidate.strokeId,
      attemptId: candidate.attemptId,
      attemptSeq: candidate.attemptSeq,
      sessionId: curSnap.sessionId,
      roundId: curSnap.round.roundId,
      inputEpoch: curSnap.inputEpoch,
      connectionGeneration: curSeat.connectionGeneration,
      calibrationVersion: curSeat.calibrationVersion,
      gestureId: curSeat.assignment.gestureId,
      inputMethod: inputMethodRef.current,
      durationMs: candidate.durationMs,
      clientCompletedAtMs: performance.now(),
      estimatedClockOffsetMs: estimatedClockOffsetMsRef.current,
    };

    // Bounded acknowledgment retry (at most 2 retries while connected & in same round/epoch)
    let attempts = 0;
    const maxAttempts = 3;
    let settled = false;

    const sendOnce = () => {
      if (settled) return;
      const latestSnap = snapRef.current;
      if (
        !sock.connected ||
        !latestSnap ||
        latestSnap.round.roundId !== payload.roundId ||
        latestSnap.inputEpoch !== payload.inputEpoch
      ) {
        settled = true;
        return;
      }

      attempts += 1;
      sock.timeout(750).emit(
        'stroke.complete',
        payload,
        (err: Error | null, ack?: AckResponse<{ strokeId: string }>) => {
          if (settled) return;
          if (err) {
            if (attempts < maxAttempts) {
              sendOnce();
            } else {
              settled = true;
              report('warn', 'Network delayed; release and try next stroke.');
            }
            return;
          }

          settled = true;
          if (ack?.ok) {
            report('accepted', 'Stroke accepted ✓ Release to return');
            if (!quiet) feedbackRef.current.playTone('accepted');
          } else {
            report('warn', ack?.message || 'Stroke not counted.');
          }
        },
      );
    };

    sendOnce();
  }, []);

  // Socket lifecycle & resume
  useEffect(() => {
    const sock = createPondSocket();
    socketRef.current = sock;

    const attemptResumeIfStored = () => {
      try {
        const raw = window.localStorage.getItem(RESUME_STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw) as StoredResume;
        if (!parsed?.resumeToken) return;

        sock.emit('player.resume', { resumeToken: parsed.resumeToken }, (res: AckResponse<PlayerPrivateSeat>) => {
          if (res?.ok && res.data) {
            setSuperseded(false);
            setSeat(res.data);
            setInputMethod(res.data.inputMethod);
            sweepRecRef.current.setGesture(res.data.assignment.gestureId);
            tiltRecRef.current.setGesture(res.data.assignment.gestureId);
            if (res.data.calibrated) {
              if (res.data.inputMethod === 'touch_fallback') {
                setStep('controller');
                return;
              }

              const storedCal = parsed.savedCalibration;
              const requiresIosPermissionTap =
                typeof window !== 'undefined' &&
                'DeviceMotionEvent' in window &&
                typeof (window.DeviceMotionEvent as unknown as { requestPermission?: unknown })
                  .requestPermission === 'function';

              if (
                storedCal &&
                storedCal.validated &&
                (storedCal.gravitySignConvention === 1 || storedCal.gravitySignConvention === -1)
              ) {
                const restoredCal: ExtendedCalibrationData = {
                  ...storedCal,
                  version: res.data.calibrationVersion,
                };
                sweepRecRef.current.setCalibration(restoredCal);
                setLocalCal(restoredCal);
                if (requiresIosPermissionTap) {
                  // iOS Safari requires a fresh user tap after a full page reload to re-grant motion events
                  setStep('sensors');
                } else {
                  sensorMgrRef.current.startListening();
                  setStep('controller');
                }
              } else {
                // Pre-existing seat without stored axis-sign calibration -> re-enable & calibrate cleanly
                const fallbackSign = detectPlatformDefaultAccelSign();
                const fallbackCal: ExtendedCalibrationData = {
                  version: res.data.calibrationVersion,
                  validated: true,
                  stationaryBias: { x: 0, y: 0, z: 0 },
                  stationaryNoiseRms: 0.12,
                  onsetThreshold: RECOGNIZER_DEFAULTS.minOnsetThresholdMps2,
                  minPeakSignal: RECOGNIZER_DEFAULTS.minPeakSignalMps2,
                  measuredSampleRateHz: 60,
                  hasLinearAcceleration: false,
                  gravityRef: { x: 0, y: 7.0 * fallbackSign, z: 6.8 * fallbackSign },
                  orientationRef: null,
                  gravitySignConvention: fallbackSign,
                };
                sweepRecRef.current.setCalibration(fallbackCal);
                setLocalCal(fallbackCal);
                setStep('sensors');
              }
            } else {
              setStep('sensors');
            }
          } else if (res?.code === 'SEAT_NOT_FOUND') {
            // The seat is gone (session restarted, or the team filled up while this phone was away)
            window.localStorage.removeItem(RESUME_STORAGE_KEY);
            setSeat(null);
            setLocalCal(null);
            setPracticeSuccesses(0);
            setStep('join');
            setJoinError(res.message || 'Your earlier seat is no longer available. Join again.');
          }
        });
      } catch {
        // Ignore malformed localStorage
      }
    };

    sock.on('connect', () => {
      setConnected(true);
      cancelActiveHold('Reconnected; press again to paddle.');
      attemptResumeIfStored();
    });

    sock.on('disconnect', () => {
      setConnected(false);
      cancelActiveHold('Connection interrupted; waiting to reconnect...');
    });

    sock.on('session.snapshot', (nextSnap: SessionPublicSnapshot) => {
      const prevSnap = snapRef.current;
      // Supersede older state revisions
      if (
        prevSnap &&
        prevSnap.sessionId === nextSnap.sessionId &&
        nextSnap.stateRevision < prevSnap.stateRevision
      ) {
        return;
      }

      // Cancel active gesture on pause, round change, inputEpoch barrier, or networkMode switch!
      if (
        prevSnap &&
        heldRef.current &&
        (prevSnap.inputEpoch !== nextSnap.inputEpoch ||
          prevSnap.round.roundId !== nextSnap.round.roundId ||
          prevSnap.runStatus !== nextSnap.runStatus ||
          prevSnap.networkModeVersion !== nextSnap.networkModeVersion)
      ) {
        cancelActiveHold('Phase or pause state changed; release and press again.');
      }

      setSnapshot(nextSnap);
    });

    sock.on('stroke.accepted', (ev: StrokeAcceptedBroadcast) => {
      const key = `${ev.teamNumber}:${ev.limbIndex}`;
      effectsRef.current.limbAcceptedFlashAtMs.set(key, performance.now());
    });

    sock.on('player.recalibrate', (payload: { minCalibrationVersion: number }) => {
      cancelActiveHold('Facilitator requested recalibration.');
      setSeat((prev) =>
        prev
          ? {
              ...prev,
              calibrated: false,
              calibrationVersion: Math.max(prev.calibrationVersion, payload.minCalibrationVersion - 1),
            }
          : prev,
      );
      setPracticeSuccesses(0);
      practicePeaksRef.current = [];
      setStep('calibrate');
      setStatusKind('warn');
      setStatusMessage('Please hold your phone steady to recalibrate.');
    });

    sock.on('player.superseded', () => {
      cancelActiveHold('This seat was opened in another browser tab.');
      setSuperseded(true);
    });

    sock.on('session.cleared', () => {
      window.localStorage.removeItem(RESUME_STORAGE_KEY);
      cancelActiveHold('Session reset by facilitator.');
      setSeat(null);
      setLocalCal(null);
      setPracticeSuccesses(0);
      setStep('join');
      setStatusMessage('Session cleared. Enter your team number to join.');
    });

    // Periodic RTT + clock-offset probe (Section 12.4)
    const probeTimer = window.setInterval(() => {
      if (!sock.connected) return;
      const t0 = performance.now();
      sock.emit(
        'connection.probe',
        { clientSentAtMs: t0, lastMeasuredRttMs: lastMeasuredRttMsRef.current },
        (resp?: { serverNowMs: number; clientSentAtMs: number }) => {
          if (!resp) return;
          const rtt = Math.max(0, performance.now() - t0);
          lastMeasuredRttMsRef.current = rtt;
          estimatedClockOffsetMsRef.current = resp.serverNowMs - (t0 + rtt / 2);
        },
      );
    }, 4000);

    return () => {
      window.clearInterval(probeTimer);
      sock.disconnect();
    };
  }, [cancelActiveHold]);

  // Sensor subscription & blur/visibility safety cancellation
  useEffect(() => {
    const mgr = sensorMgrRef.current;

    const unsub = mgr.subscribe((sample) => {
      if (isCalibratingRef.current) {
        calibratorRef.current.pushSample(sample);
        return;
      }

      if (inputMethodRef.current === 'touch_fallback') {
        return;
      }

      const recUpdate =
        inputMethodRef.current === 'tilt'
          ? tiltRecRef.current.pushSample(sample)
          : sweepRecRef.current.pushSample(sample);

      if (heldRef.current) {
        setProgress(recUpdate.progress);

        // Continuous preview streaming ONLY when networkMode === 'continuous' & connected (throttled <= 16.6 Hz)
        const curSnap = snapRef.current;
        const curSeat = seatRef.current;
        const sock = socketRef.current;
        if (
          mirrorsInputToServer() &&
          curSnap?.networkMode === 'continuous' &&
          sock?.connected &&
          curSeat &&
          sample.timestampMs - lastPreviewSentMsRef.current >= GAME_DEFAULTS.previewIntervalMs
        ) {
          lastPreviewSentMsRef.current = sample.timestampMs;
          const meta =
            inputMethodRef.current === 'tilt'
              ? tiltRecRef.current.getAttemptMeta()
              : sweepRecRef.current.getAttemptMeta();
          sock.volatile.emit('input.preview', {
            attemptId: meta.attemptId,
            attemptSeq: meta.attemptSeq,
            sessionId: curSnap.sessionId,
            roundId: curSnap.round.roundId,
            inputEpoch: curSnap.inputEpoch,
            connectionGeneration: curSeat.connectionGeneration,
            progress: recUpdate.progress,
          });
        }
      }

      if (recUpdate.justLatchedSuccess && recUpdate.strokeCandidate) {
        // Optional haptic pulse ONLY after recognition has latched!
        feedbackRef.current.pulseLatchedRecognition();

        if (stepRef.current === 'practice') {
          practicePeaksRef.current.push(recUpdate.strokeCandidate.peakSignalMps2);
          setPracticeSuccesses((prev) => prev + 1);
          setStatusKind('accepted');
          setStatusMessage('Great sweep! Release button to return.');
          feedbackRef.current.playTone('accepted');
          if (mirrorsInputToServer()) submitStrokeToServer(recUpdate.strokeCandidate, true);
        } else if (stepRef.current === 'controller') {
          submitStrokeToServer(recUpdate.strokeCandidate);
        }
      } else if (recUpdate.justLatchedFailure) {
        setStatusKind('warn');
        setStatusMessage(recUpdate.reasonText);
        feedbackRef.current.playTone('rejected');
      }
    });

    const onVisibilityOrBlur = () => {
      if (document.hidden || heldRef.current) {
        cancelActiveHold('Gesture canceled when page lost focus.');
      }
    };
    window.addEventListener('blur', onVisibilityOrBlur);
    document.addEventListener('visibilitychange', onVisibilityOrBlur);

    return () => {
      unsub();
      window.removeEventListener('blur', onVisibilityOrBlur);
      document.removeEventListener('visibilitychange', onVisibilityOrBlur);
    };
  }, [cancelActiveHold, mirrorsInputToServer, submitStrokeToServer]);

  // =========================================================================
  // Onboarding Handlers
  // =========================================================================

  const handleJoinSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setJoinError(null);
    const num = Number(teamInput.trim());
    if (!Number.isInteger(num) || num < 1) {
      setJoinError('Enter the team number given by your facilitator (e.g. 1 to 6).');
      return;
    }
    const playerName = sanitizePlayerName(nameInput);
    if (!playerName) {
      setJoinError('Enter a name or nickname so your team can spot you.');
      return;
    }
    const sock = socketRef.current;
    if (!sock || !sock.connected) {
      setJoinError('Waiting for live server connection...');
      return;
    }

    setJoining(true);
    sock.emit('player.join', { teamNumber: num, playerName }, (res: AckResponse<PlayerPrivateSeat>) => {
      setJoining(false);
      if (!res?.ok || !res.data) {
        setJoinError(res?.message || 'Could not join that team.');
        return;
      }

      window.localStorage.setItem(
        RESUME_STORAGE_KEY,
        JSON.stringify({ sessionId: res.data.sessionId, resumeToken: res.data.resumeToken }),
      );

      // iOS "Shake to Undo": a web page cannot switch it off, but the prompt only has something to
      // offer while this page holds typing history. The name and team number are the only things
      // ever typed, so reloading once here starts the rest of the activity with nothing to undo.
      // The seat comes straight back through the stored resume token; it is only done when that
      // token is confirmed saved. UNTESTED on a physical iPhone.
      if (isAppleTouchDevice()) {
        try {
          const saved = window.localStorage.getItem(RESUME_STORAGE_KEY);
          if (saved && saved.includes(res.data.resumeToken)) {
            window.location.reload();
            return;
          }
        } catch {
          // Storage unavailable: carry on without the reload rather than risk losing the seat
        }
      }
      setSeat(res.data);
      sweepRecRef.current.setGesture(res.data.assignment.gestureId);
      tiltRecRef.current.setGesture(res.data.assignment.gestureId);
      setStep('sensors');
    });
  };

  const handleEnableMotion = async () => {
    setCheckingSensors(true);
    const report = await sensorMgrRef.current.enableAndCheckCapabilities(650);
    setCheckingSensors(false);
    setCapReport(report);

    socketRef.current?.emit('sensor.status', {
      sensorStatus: report.status,
      inputMethod: 'physical_sweep',
      note: report.summaryMessage,
    });

    if (report.status === 'ready') {
      setInputMethod('physical_sweep');
      setStep('calibrate');
    }
  };

  const handleChooseExplicitFallback = (fallbackMethod: 'tilt' | 'touch_fallback') => {
    setInputMethod(fallbackMethod);
    socketRef.current?.emit('sensor.status', {
      sensorStatus: capReport?.status ?? 'unsupported',
      inputMethod: fallbackMethod,
      note: `Selected explicit ${fallbackMethod} mode`,
    });

    if (fallbackMethod === 'touch_fallback' && seat) {
      const touchCal: CalibrationSummary = {
        version: seat.calibrationVersion + 1,
        validated: true,
        stationaryBias: { x: 0, y: 0, z: 0 },
        stationaryNoiseRms: 0,
        onsetThreshold: 0,
        minPeakSignal: 0,
        measuredSampleRateHz: 0,
        hasLinearAcceleration: false,
      };
      socketRef.current?.emit(
        'calibration.complete',
        {
          assignmentVersion: seat.assignment.assignmentVersion,
          calibration: touchCal,
          inputMethod: 'touch_fallback',
        },
        (res: AckResponse<{ calibrationVersion: number }>) => {
          if (res?.ok && res.data) {
            setSeat((prev) =>
              prev
                ? {
                    ...prev,
                    calibrated: true,
                    calibrationVersion: res.data!.calibrationVersion,
                    inputMethod: 'touch_fallback',
                  }
                : prev,
            );
            setStep('practice');
          }
        },
      );
    } else {
      sensorMgrRef.current.startListening();
      setStep('calibrate');
    }
  };

  const handleStartCalibration = () => {
    if (!seat) return;
    calibratorRef.current.resetSamples();
    isCalibratingRef.current = true;
    setCalibrating(true);

    window.setTimeout(() => {
      isCalibratingRef.current = false;
      setCalibrating(false);
      const extCal = calibratorRef.current.finalize(seat.calibrationVersion);
      setLocalCal(extCal);

      if (!extCal.validated) {
        setStatusKind('warn');
        setStatusMessage('Phone moved or no motion samples arrived during calibration. Hold steady and retry.');
        return;
      }

      sweepRecRef.current.setCalibration(extCal);

      const summary: CalibrationSummary = {
        version: extCal.version,
        validated: extCal.validated,
        stationaryBias: extCal.stationaryBias,
        stationaryNoiseRms: extCal.stationaryNoiseRms,
        onsetThreshold: extCal.onsetThreshold,
        minPeakSignal: extCal.minPeakSignal,
        measuredSampleRateHz: extCal.measuredSampleRateHz,
        hasLinearAcceleration: extCal.hasLinearAcceleration,
        gravitySignConvention: extCal.gravitySignConvention,
      };

      socketRef.current?.emit(
        'calibration.complete',
        {
          assignmentVersion: seat.assignment.assignmentVersion,
          calibration: summary,
          inputMethod,
        },
        (res: AckResponse<{ calibrationVersion: number }>) => {
          if (res?.ok && res.data) {
            const finalCal = { ...extCal, version: res.data.calibrationVersion };
            sweepRecRef.current.setCalibration(finalCal);
            setLocalCal(finalCal);
            try {
              window.localStorage.setItem(
                RESUME_STORAGE_KEY,
                JSON.stringify({
                  sessionId: seat.sessionId,
                  resumeToken: seat.resumeToken,
                  savedCalibration: finalCal,
                } satisfies StoredResume),
              );
            } catch {
              // Ignore storage quota errors
            }
            setSeat((prev) =>
              prev
                ? {
                    ...prev,
                    calibrated: true,
                    calibrationVersion: res.data!.calibrationVersion,
                  }
                : prev,
            );
            setPracticeSuccesses(0);
            practicePeaksRef.current = [];
            setStep('practice');
            setStatusKind('neutral');
            setStatusMessage('Try 3 comfortable seated sweeps (10 to 20 cm).');
          }
        },
      );
    }, RECOGNIZER_DEFAULTS.stationaryCalibrationMs);
  };

  const finishPracticeIntoController = () => {
    // Optionally refine comfortable minPeakSignal if practice sweeps were recorded
    if (localCal && practicePeaksRef.current.length >= 2) {
      const sorted = [...practicePeaksRef.current].sort((a, b) => a - b);
      const refinedMinPeak = Math.min(3.8, Math.max(1.75, sorted[0] * 0.65));
      const updated = { ...localCal, minPeakSignal: refinedMinPeak };
      setLocalCal(updated);
      sweepRecRef.current.setCalibration(updated);
    }
    setStep('controller');
    setStatusKind('neutral');
    setStatusMessage('Ready! Press, move along your arrow, release.');
  };

  // Mission Control can bring a ready player along: once the facilitator loads anything past Training,
  // a phone that already has its three practice sweeps moves into the controller on its own, so nobody
  // is left behind for forgetting the "Enter Controller" button. Players short of three stay in practice.
  const practiceComplete = practiceSuccesses >= RECOGNIZER_DEFAULTS.practiceAttemptsTarget;
  const sessionMovedPastTraining =
    snapshot != null && snapshot.phase !== 'lobby' && snapshot.phase !== 'training';
  useEffect(() => {
    if (step !== 'practice' || held) return;
    if (!practiceComplete || !sessionMovedPastTraining) return;
    // Waits for the pad to be released (held) so a sweep in progress is never cut off
    finishPracticeIntoController();
  }, [step, held, practiceComplete, sessionMovedPastTraining]);

  // =========================================================================
  // Pointer-Captured Paddle Hold & Touch Fallback Handlers
  // =========================================================================

  const canSubmitLiveInput =
    step === 'practice' ||
    (step === 'controller' &&
      connected &&
      seat?.calibrated &&
      snapshot &&
      snapshot.phase !== 'lobby' &&
      (snapshot.runStatus === 'running' || snapshot.runStatus === 'countdown'));

  const handlePadPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!seat || (!canSubmitLiveInput && step === 'controller')) return;

    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Ignore synthetic events without active pointerId
    }

    heldRef.current = true;
    setHeld(true);

    if (inputMethod === 'touch_fallback') {
      touchSeqCounterRef.current += 1;
      const attemptSeq = touchSeqCounterRef.current;
      const attemptId = `tfa_${Date.now().toString(36)}_${attemptSeq}`;
      touchStartPtRef.current = {
        x: e.clientX,
        y: e.clientY,
        atMs: performance.now(),
        attemptId,
        attemptSeq,
        latched: false,
      };
      setProgress(0.08);
      setStatusKind('neutral');
      setStatusMessage(`Slide finger: ${GESTURE_SPECS[seat.assignment.gestureId].instruction}`);

      if (mirrorsInputToServer() && snapshot && socketRef.current?.connected) {
        socketRef.current.emit('input.begin', {
          attemptId,
          attemptSeq,
          sessionId: snapshot.sessionId,
          roundId: snapshot.round.roundId,
          inputEpoch: snapshot.inputEpoch,
          connectionGeneration: seat.connectionGeneration,
          calibrationVersion: seat.calibrationVersion,
          inputMethod: 'touch_fallback',
        });
      }
      return;
    }

    const ori = sensorMgrRef.current.getLatestOrientation();
    const recStep =
      inputMethod === 'tilt'
        ? tiltRecRef.current.beginAttempt(performance.now(), ori)
        : sweepRecRef.current.beginAttempt(performance.now(), ori);

    setProgress(recStep.progress);
    setStatusKind('neutral');
    setStatusMessage(recStep.reasonText);

    const meta =
      inputMethod === 'tilt'
        ? tiltRecRef.current.getAttemptMeta()
        : sweepRecRef.current.getAttemptMeta();

    if (mirrorsInputToServer() && snapshot && socketRef.current?.connected) {
      socketRef.current.emit('input.begin', {
        attemptId: meta.attemptId,
        attemptSeq: meta.attemptSeq,
        sessionId: snapshot.sessionId,
        roundId: snapshot.round.roundId,
        inputEpoch: snapshot.inputEpoch,
        connectionGeneration: seat.connectionGeneration,
        calibrationVersion: seat.calibrationVersion,
        inputMethod,
      });
    }
  };

  const handlePadPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!heldRef.current || inputMethod !== 'touch_fallback' || !seat) return;
    const start = touchStartPtRef.current;
    if (!start || start.latched) return;

    const dx = e.clientX - start.x;
    const dyScreenUp = -(e.clientY - start.y); // Screen +y is UP
    const distPx = Math.hypot(dx, dyScreenUp);
    const targetPx = 68;

    if (distPx < 10) return;

    const desired = GESTURE_SPECS[seat.assignment.gestureId].desiredDir;
    const cosA = Math.max(-1, Math.min(1, (dx * desired.x + dyScreenUp * desired.y) / distPx));
    const angleErrDeg = (Math.acos(cosA) * 180) / Math.PI;

    if (distPx >= 24 && angleErrDeg > 45) {
      start.latched = true;
      setProgress(0);
      setStatusKind('warn');
      setStatusMessage(`Wrong swipe direction (${Math.round(angleErrDeg)}° off). Release and retry.`);
      feedbackRef.current.playTone('rejected');
      return;
    }

    const prog = Math.min(1, distPx / targetPx);
    setProgress(prog);

    if (
      mirrorsInputToServer() &&
      snapshot?.networkMode === 'continuous' &&
      socketRef.current?.connected &&
      performance.now() - lastPreviewSentMsRef.current >= GAME_DEFAULTS.previewIntervalMs
    ) {
      lastPreviewSentMsRef.current = performance.now();
      socketRef.current.volatile.emit('input.preview', {
        attemptId: start.attemptId,
        attemptSeq: start.attemptSeq,
        sessionId: snapshot.sessionId,
        roundId: snapshot.round.roundId,
        inputEpoch: snapshot.inputEpoch,
        connectionGeneration: seat.connectionGeneration,
        progress: prog,
      });
    }

    const elapsedMs = performance.now() - start.atMs;
    if (distPx >= targetPx && elapsedMs >= 110) {
      start.latched = true;
      setProgress(1);
      feedbackRef.current.pulseLatchedRecognition();

      const touchCandidate: RecognizedStrokeCandidate = {
        strokeId: `tfstk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        attemptId: start.attemptId,
        attemptSeq: start.attemptSeq,
        gestureId: seat.assignment.gestureId,
        durationMs: Math.max(150, Math.round(elapsedMs)),
        peakSignalMps2: 1,
        forwardImpulseMps: 1,
        workingAngleDeg: 0,
        targetAngleDeg: 0,
        angleErrorDeg: Math.round(angleErrDeg),
        consistency: 1,
      };

      if (step === 'practice') {
        setPracticeSuccesses((c) => c + 1);
        setStatusKind('accepted');
        setStatusMessage('Touch fallback stroke recognized ✓ Release finger.');
        feedbackRef.current.playTone('accepted');
        if (mirrorsInputToServer()) submitStrokeToServer(touchCandidate, true);
      } else if (step === 'controller') {
        submitStrokeToServer(touchCandidate);
      }
    }
  };

  const handlePadPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!heldRef.current) return;
    heldRef.current = false;
    setHeld(false);
    setProgress(0);

    const curSeat = seatRef.current;
    const curSnap = snapRef.current;

    if (inputMethod === 'touch_fallback') {
      const start = touchStartPtRef.current;
      touchStartPtRef.current = null;
      if (start && !start.latched) {
        setStatusKind('warn');
        setStatusMessage('Swipe further along the arrow before releasing.');
      }
      if (mirrorsInputToServer() && start && curSeat && curSnap && socketRef.current?.connected) {
        socketRef.current.emit('input.release', {
          attemptId: start.attemptId,
          attemptSeq: start.attemptSeq,
          sessionId: curSnap.sessionId,
          roundId: curSnap.round.roundId,
          inputEpoch: curSnap.inputEpoch,
          connectionGeneration: curSeat.connectionGeneration,
        });
      }
      return;
    }

    const meta =
      inputMethod === 'tilt'
        ? tiltRecRef.current.getAttemptMeta()
        : sweepRecRef.current.getAttemptMeta();

    const relStep =
      inputMethod === 'tilt'
        ? tiltRecRef.current.releaseAttempt()
        : sweepRecRef.current.releaseAttempt(performance.now());

    if (relStep.justLatchedSuccess && relStep.strokeCandidate) {
      feedbackRef.current.pulseLatchedRecognition();
      if (step === 'practice') {
        practicePeaksRef.current.push(relStep.strokeCandidate.peakSignalMps2);
        setPracticeSuccesses((c) => c + 1);
        setStatusKind('accepted');
        setStatusMessage('Great sweep! Release complete.');
        if (mirrorsInputToServer()) submitStrokeToServer(relStep.strokeCandidate, true);
      } else if (step === 'controller') {
        submitStrokeToServer(relStep.strokeCandidate);
      }
    } else if (relStep.justLatchedFailure) {
      setStatusKind('warn');
      setStatusMessage(relStep.reasonText);
    }

    if (mirrorsInputToServer() && meta.attemptId && curSeat && curSnap && socketRef.current?.connected) {
      socketRef.current.emit('input.release', {
        attemptId: meta.attemptId,
        attemptSeq: meta.attemptSeq,
        sessionId: curSnap.sessionId,
        roundId: curSnap.round.roundId,
        inputEpoch: curSnap.inputEpoch,
        connectionGeneration: curSeat.connectionGeneration,
      });
    }
  };

  // Dev-only synthetic sweep injection (STRICTLY disabled unless server ENABLE_DEV_SIM=true)
  const triggerDevSimulatedStroke = () => {
    if (!snapshot?.devSimAvailable || !seat) return;
    const t0 = performance.now();
    if (!sweepRecRef.current.getCalibration()) {
      const calSamples = generateStationarySamples(t0 - 900, 800, 60, false);
      calibratorRef.current.resetSamples();
      calSamples.forEach((s) => calibratorRef.current.pushSample(s));
      const cal = calibratorRef.current.finalize(seat.calibrationVersion || 1);
      sweepRecRef.current.setCalibration(cal);
    }

    const metaStep = sweepRecRef.current.beginAttempt(t0, { beta: 55, gamma: 3 });
    const meta = sweepRecRef.current.getAttemptMeta();
    if (mirrorsInputToServer() && socketRef.current?.connected) {
      socketRef.current.emit('input.begin', {
        attemptId: meta.attemptId,
        attemptSeq: meta.attemptSeq,
        sessionId: snapshot.sessionId,
        roundId: snapshot.round.roundId,
        inputEpoch: snapshot.inputEpoch,
        connectionGeneration: seat.connectionGeneration,
        calibrationVersion: seat.calibrationVersion,
        inputMethod: 'physical_sweep',
      });
    }
    void metaStep;

    const samples = generateRealisticSweepSamples(seat.assignment.gestureId, {
      startTimestampMs: t0 + 16,
      includeLinearSensor: false,
    });
    samples.forEach((s) => sensorMgrRef.current.injectDevSyntheticSample(s));
    sweepRecRef.current.releaseAttempt(samples[samples.length - 1].timestampMs + 20);
    if (mirrorsInputToServer() && socketRef.current?.connected) {
      socketRef.current.emit('input.release', {
        attemptId: meta.attemptId,
        attemptSeq: meta.attemptSeq,
        sessionId: snapshot.sessionId,
        roundId: snapshot.round.roundId,
        inputEpoch: snapshot.inputEpoch,
        connectionGeneration: seat.connectionGeneration,
      });
    }
  };

  // =========================================================================
  // Render Views
  // =========================================================================

  if (superseded) {
    return (
      <main className="play-shell">
        <section className="onboard-panel">
          <h1>Seat Active in Another Tab</h1>
          <p>
            Each limb seat only allows one active controller tab so duplicate strokes cannot occur.
          </p>
          <button
            type="button"
            className="btn-primary"
            onClick={() => window.location.reload()}
          >
            Resume Seat in This Tab
          </button>
        </section>
      </main>
    );
  }

  if (step === 'join' || !seat) {
    return (
      <main className="play-shell">
        <header className="play-topbar">
          <span className="play-topbar-title">CS260B Shared-Body Pond</span>
          <span className={`pill ${connected ? 'pill-running' : 'pill-danger'}`}>
            {connected ? 'Connected' : 'Connecting...'}
          </span>
        </header>

        <section className="onboard-panel">
          <h1>Join Your Team!</h1>
          <p>
            Enter your name or nickname and the team number given by your facilitator. You will control one paddle throughout
            training and the race.
          </p>

          <form onSubmit={handleJoinSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <label htmlFor="player-name-input" className="field-label">
              Your Name or Nickname
            </label>
            <input
              id="player-name-input"
              className="field-input"
              type="text"
              autoComplete="nickname"
              autoCapitalize="words"
              enterKeyHint="next"
              maxLength={PLAYER_NAME_MAX_LENGTH}
              placeholder="e.g. Sam"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              required
            />
            <div style={{ fontSize: '0.8rem', color: 'var(--ink-secondary)' }}>
              Shown on the classroom screen next to your limb.
            </div>
            <label htmlFor="team-number-input" className="field-label">
              Assigned Team Number
            </label>
            <input
              id="team-number-input"
              className="field-input field-input-hero"
              type="number"
              inputMode="numeric"
              min={1}
              max={snapshot?.maxTeamNumber ?? 15}
              placeholder="1"
              value={teamInput}
              onChange={(e) => setTeamInput(e.target.value)}
              required
            />
            {joinError && (
              <div className="status-banner status-banner-warn" role="alert">
                {joinError}
              </div>
            )}
            <button type="submit" className="btn-primary" disabled={!connected || joining}>
              {joining ? 'Joining Team...' : 'Join Team'}
            </button>
          </form>

          {snapshot && (
            <div style={{ fontSize: '0.84rem', color: 'var(--ink-secondary)' }}>
              <div>
                Team size range: <strong>{snapshot.minTeamSize}–{snapshot.maxTeamSize}</strong>{' '}
                players per creature
              </div>
              {snapshot.teams.length > 0 && (
                <div style={{ marginTop: '0.25rem' }}>
                  Active teams:{' '}
                  {snapshot.teams
                    .map((t) => `Team ${t.teamNumber} (${t.limbCount}/${t.maxSeats})`)
                    .join(' · ')}
                </div>
              )}
            </div>
          )}
        </section>
      </main>
    );
  }

  const teamState = snapshot?.teams.find((t) => t.teamNumber === seat.teamNumber) ?? null;
  // Limbs are renumbered when a teammate's limb is released or grows back, so this phone's limb is
  // looked up in the live snapshot instead of trusting the number it was given at join
  const myLimb = teamState?.limbs.find((l) => l.assignedPlayerId === seat.playerId) ?? null;
  const myLimbIndex = myLimb ? myLimb.limbIndex : seat.limbIndex;
  const myLimbLabel = myLimb ? myLimb.limbLabel : seat.limbLabel;
  // The emoji is this player's badge on every screen; it never changes during the session
  const myEmoji = seat.playerEmoji ?? myLimb?.playerEmoji ?? '';
  const sweepStage: SweepStage = !held ? 'press' : statusKind === 'accepted' ? 'release' : 'move';

  // Onboarding Steps: Sensors -> Calibrate -> Practice
  if (step !== 'controller') {
    return (
      <main className={`play-shell ${step === 'practice' ? 'play-practice-fit' : ''}`}>
        <header className="play-topbar">
          <div className="onboard-identity">
            <span className="team-swatch-dot" style={{ backgroundColor: seat.colorHex }} />
            <span className="play-topbar-title">
              {myEmoji} {seat.playerName} · Team {seat.teamNumber} · {myLimbLabel}
            </span>
          </div>
          <span className={`pill ${connected ? 'pill-running' : 'pill-danger'}`}>
            {connected ? 'Live' : 'Reconnecting'}
          </span>
        </header>

        {step === 'sensors' && (
          <section className="onboard-panel">
            <SetupStepTrack current={1} />
            <h1>
              You're In, {myEmoji} {seat.playerName}! Team {seat.teamNumber} · {myLimbLabel}
            </h1>
            <p>
              Your assigned movement is <strong>{GESTURE_SPECS[seat.assignment.gestureId].instruction}</strong>.
              Every stroke is the same three beats:
            </p>
            <SweepSteps />
            <p>Tap below to enable phone motion sensors.</p>

            <button
              type="button"
              className="btn-primary"
              disabled={checkingSensors}
              onClick={() => void handleEnableMotion()}
            >
              {checkingSensors ? 'Checking Motion Sensors...' : 'Enable Motion'}
            </button>

            {capReport && capReport.status !== 'ready' && (
              <div className="status-banner status-banner-warn" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
                <div>{capReport.summaryMessage}</div>
                <div className="btn-row" style={{ marginTop: '0.4rem' }}>
                  <button
                    type="button"
                    className="btn-secondary btn-xs"
                    onClick={() => handleChooseExplicitFallback('touch_fallback')}
                  >
                    Use Touch Swipe Fallback
                  </button>
                  {capReport.hasDeviceOrientationApi && (
                    <button
                      type="button"
                      className="btn-subtle btn-xs"
                      onClick={() => handleChooseExplicitFallback('tilt')}
                    >
                      Use Explicit Tilt Fallback
                    </button>
                  )}
                </div>
              </div>
            )}

            {snapshot?.devSimAvailable && (
              <button
                type="button"
                className="btn-subtle btn-xs"
                onClick={() => {
                  setInputMethod('physical_sweep');
                  setStep('calibrate');
                }}
              >
                [DEV SIM] Skip Hardware Check to Calibrate
              </button>
            )}
          </section>
        )}

        {step === 'calibrate' && (
          <section className="onboard-panel">
            <SetupStepTrack current={2} />
            <h1>Hold Phone Steady to Calibrate</h1>
            <p>
              Sit comfortably and hold your phone in <strong>portrait orientation</strong> with the
              screen facing you. Keep your hand still for under a second.
            </p>
            <p className="rotation-tip">
              <strong>Lock screen rotation first</strong> so a sweep can't flip this page sideways.
              iPhone: swipe down from the top-right corner and tap the rotation lock. Android: swipe
              down from the top and switch Auto-rotate off.
            </p>

            <button
              type="button"
              className="btn-primary"
              disabled={calibrating}
              onClick={handleStartCalibration}
            >
              {calibrating ? 'Calibrating... Hold Still' : 'Capture Stationary Reference'}
            </button>

            {statusKind === 'warn' && <div className="status-banner status-banner-warn">{statusMessage}</div>}

            {snapshot?.devSimAvailable && (
              <button
                type="button"
                className="btn-subtle btn-xs"
                onClick={() => {
                  const samples = generateStationarySamples(performance.now(), 800, 60, false);
                  calibratorRef.current.resetSamples();
                  samples.forEach((s) => calibratorRef.current.pushSample(s));
                  const ext = calibratorRef.current.finalize(seat.calibrationVersion);
                  sweepRecRef.current.setCalibration(ext);
                  setLocalCal(ext);
                  socketRef.current?.emit(
                    'calibration.complete',
                    {
                      assignmentVersion: seat.assignment.assignmentVersion,
                      calibration: ext,
                      inputMethod: 'physical_sweep',
                    },
                    (res: AckResponse<{ calibrationVersion: number }>) => {
                      if (res?.ok && res.data) {
                        const updated = { ...ext, version: res.data.calibrationVersion };
                        sweepRecRef.current.setCalibration(updated);
                        setSeat((p) =>
                          p ? { ...p, calibrated: true, calibrationVersion: res.data!.calibrationVersion } : p,
                        );
                        setStep('practice');
                      }
                    },
                  );
                }}
              >
                [DEV SIM] Complete Synthetic Calibration
              </button>
            )}
          </section>
        )}

        {/* Practice: head, tip, sweep demo, status, pad, actions. Sized to one screen so the pad and
            the way forward are both visible without scrolling. */}
        {step === 'practice' && (
          <section className="onboard-panel practice-panel">
            <div className="practice-head">
              <SetupStepTrack current={3} showLabel={false} />
              <h1 className="practice-title">
                Practice{' '}
                <span className="practice-count">
                  {Math.min(RECOGNIZER_DEFAULTS.practiceAttemptsTarget, practiceSuccesses)} /{' '}
                  {RECOGNIZER_DEFAULTS.practiceAttemptsTarget}
                </span>
              </h1>
            </div>

            {sessionMovedPastTraining && !practiceComplete ? (
              <p className="practice-tip practice-tip-alert" role="status">
                The class moved on to {describePhase(snapshot.phase, snapshot.round.scoringEnabled)}.
                Finish your sweeps or tap Skip.
              </p>
            ) : (
              <p className="practice-tip">
                <strong>Press</strong> the pad, <strong>move</strong> the phone 10 to 20 cm along
                your arrow, <strong>release</strong>, then bring it back.
              </p>
            )}

            <GestureDemoBadge
              gestureId={seat.assignment.gestureId}
              animate={animateDemo}
              onToggleAnimate={() => setAnimateDemo((a) => !a)}
              compact
            />

            <div
              className={`status-banner status-banner-fixed ${statusKind === 'accepted' ? 'status-banner-accepted' : statusKind === 'warn' ? 'status-banner-warn' : ''}`}
              role="status"
              aria-live="polite"
            >
              <span>{statusMessage}</span>
              {snapshot?.devSimAvailable && (
                <button type="button" className="btn-subtle btn-xs" onClick={triggerDevSimulatedStroke}>
                  [DEV SIM]
                </button>
              )}
            </div>

            <div
              role="button"
              tabIndex={0}
              className={`paddle-hold-pad ${held ? 'is-held' : ''} ${statusKind === 'accepted' ? 'is-accepted' : ''}`}
              onContextMenu={(e) => e.preventDefault()}
              onPointerDown={handlePadPointerDown}
              onPointerMove={handlePadPointerMove}
              onPointerUp={handlePadPointerUp}
              onPointerCancel={handlePadPointerUp}
              onLostPointerCapture={() => cancelActiveHold('Pointer capture released.')}
            >
              {statusKind === 'accepted' && acceptedPopSeq > 0 && (
                <AcceptedPop key={acceptedPopSeq} seq={acceptedPopSeq} />
              )}
              <SweepSteps stage={sweepStage} />
              <div className="paddle-hold-title">
                {inputMethod === 'touch_fallback'
                  ? 'Press & Swipe Arrow'
                  : held
                    ? 'Move, Then Release'
                    : 'Press & Hold'}
              </div>
              <div className="paddle-hold-hint">
                {GESTURE_SPECS[seat.assignment.gestureId].instruction}
              </div>
              <div className="paddle-progress-track">
                <div className="paddle-progress-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
              </div>
            </div>

            <div className="practice-actions">
              <button
                type="button"
                className="btn-subtle btn-xs"
                onClick={() => {
                  cancelActiveHold('Recalibrating...');
                  setStep('calibrate');
                  setStatusKind('neutral');
                  setStatusMessage('Hold phone steady in portrait orientation.');
                }}
              >
                Recalibrate
              </button>
              <button
                type="button"
                className={practiceComplete ? 'btn-primary' : 'btn-secondary'}
                onClick={finishPracticeIntoController}
              >
                {practiceComplete ? 'Enter Controller →' : 'Skip Practice'}
              </button>
            </div>
          </section>
        )}
      </main>
    );
  }

  // =========================================================================
  // Compact Non-Scrolling Portrait Live Controller (Section 6.3)
  // =========================================================================

  const phaseBannerText = !connected
    ? 'Reconnecting to pond server...'
    : snapshot?.phase === 'lobby'
      ? 'Waiting for facilitator to open Training...'
      : snapshot?.phase === 'discussion'
        ? 'Discussion time. Eyes on the classroom screen.'
        : snapshot?.phase === 'leaderboard'
          ? 'Leaderboard is up on the classroom screen!'
          : snapshot?.runStatus === 'paused'
            ? 'Paused by facilitator. Wait to resume.'
            : snapshot?.runStatus === 'ready'
              ? `Up next: ${describePhase(snapshot.phase, snapshot.round.scoringEnabled)}. Waiting for Start.`
              : snapshot?.runStatus === 'countdown'
            ? `Get ready! Starting in ${Math.ceil((snapshot.round.countdownRemainingMs || 1000) / 1000)}...`
            : snapshot?.runStatus === 'finished'
              ? 'Round finished! Check classroom screen for results'
              : statusMessage;

  const padDisabled = !canSubmitLiveInput;
  const canRecalibrateNow =
    snapshot?.phase === 'lobby' ||
    snapshot?.phase === 'training' ||
    snapshot?.runStatus === 'paused' ||
    snapshot?.runStatus === 'ready';

  return (
    <main className="play-shell play-controller-locked">
      {/* Row 1: identity and preferences. Two fixed text lines, so its height never depends on the name. */}
      <header className="play-topbar controller-topbar">
        <div className="controller-identity">
          <span className="team-swatch-dot" style={{ backgroundColor: seat.colorHex }} />
          <div className="controller-identity-text">
            <div className="play-topbar-title">
              Team {seat.teamNumber} · {myLimbLabel}
            </div>
            <div className="controller-identity-sub">
              {myEmoji} {seat.playerName} ·{' '}
              {inputMethod === 'physical_sweep'
                ? 'Physical Sweep'
                : inputMethod === 'tilt'
                  ? 'Tilt Fallback'
                  : 'Touch Fallback'}
            </div>
          </div>
        </div>

        <div className="controller-tools">
          {/* Always rendered so the bar keeps its height; only usable while no round is live */}
          {inputMethod !== 'touch_fallback' && (
            <button
              type="button"
              className="btn-subtle btn-xs"
              disabled={!canRecalibrateNow}
              onClick={() => {
                cancelActiveHold('Recalibrating...');
                setPracticeSuccesses(0);
                practicePeaksRef.current = [];
                setStep('calibrate');
              }}
            >
              Recalibrate
            </button>
          )}
          <button
            type="button"
            className="btn-subtle btn-xs"
            onClick={() => {
              const next = !muted;
              setMuted(next);
              feedbackRef.current.setMuted(next);
            }}
          >
            {muted ? 'Unmute' : 'Mute'}
          </button>
          {FeedbackController.supportsVibration() && (
            <button
              type="button"
              className="btn-subtle btn-xs"
              onClick={() => {
                const next = !hapticsOn;
                setHapticsOn(next);
                feedbackRef.current.setHapticsEnabled(next);
              }}
            >
              {hapticsOn ? 'Haptics On' : 'Haptics Off'}
            </button>
          )}
        </div>
      </header>

      {/* Row 2: creature mini-view with this player's limb highlighted, beside the assigned sweep.
          The arrow tile is the stop/replay control for the looping demo. */}
      <div className="controller-visual-row">
        {teamState && (
          <div className="play-creature-wrap">
            <CreatureCardCanvas
              team={teamState}
              effects={effectsRef.current}
              focusLimbIndex={myLimbIndex}
              localFocusLimbHeld={held}
              localFocusLimbProgress={progress}
              isPaused={snapshot?.runStatus === 'paused'}
              width={230}
              height={130}
            />
          </div>
        )}
        <GestureDemoBadge
          gestureId={seat.assignment.gestureId}
          animate={animateDemo}
          onToggleAnimate={() => setAnimateDemo((a) => !a)}
          tile
        />
      </div>

      {/* Row 3: immediate local & server feedback. Fixed two-line height so the pad never jumps. */}
      <div
        className={`status-banner status-banner-fixed ${
          !canSubmitLiveInput
            ? 'status-banner-warn'
            : statusKind === 'accepted'
              ? 'status-banner-accepted'
              : statusKind === 'local'
                ? 'status-banner-local'
                : statusKind === 'warn'
                  ? 'status-banner-warn'
                  : ''
        }`}
        role="status"
        aria-live="polite"
      >
        <span>{phaseBannerText}</span>
        {snapshot?.devSimAvailable && canSubmitLiveInput && (
          <button
            type="button"
            className="btn-subtle btn-xs"
            onClick={triggerDevSimulatedStroke}
          >
            [DEV SIM]
          </button>
        )}
      </div>

      {/* Row 4: large thumb-accessible hold-to-paddle control; takes all remaining height */}
      <div
        role="button"
        tabIndex={0}
        aria-disabled={padDisabled}
        className={`paddle-hold-pad ${padDisabled ? 'is-disabled' : ''} ${held ? 'is-held' : ''} ${
          statusKind === 'accepted' && held ? 'is-accepted' : ''
        }`}
        onContextMenu={(e) => e.preventDefault()}
        onPointerDown={handlePadPointerDown}
        onPointerMove={handlePadPointerMove}
        onPointerUp={handlePadPointerUp}
        onPointerCancel={handlePadPointerUp}
        onLostPointerCapture={() => {
          if (heldRef.current) cancelActiveHold('Pointer capture lost; press again.');
        }}
      >
        {statusKind === 'accepted' && canSubmitLiveInput && acceptedPopSeq > 0 && (
          <AcceptedPop key={acceptedPopSeq} seq={acceptedPopSeq} />
        )}
        {!padDisabled && <SweepSteps stage={sweepStage} />}
        <div className="paddle-hold-title">
          {padDisabled
            ? snapshot?.runStatus === 'paused'
              ? 'Paused'
              : 'Stand By'
            : inputMethod === 'touch_fallback'
              ? held
                ? 'Swipe Along Arrow'
                : 'Press & Swipe to Paddle'
              : held
                ? statusKind === 'accepted'
                  ? 'Got It ✓ Release!'
                  : 'Move, Then Release'
                : 'Press & Hold'}
        </div>
        <div className="paddle-hold-hint">{GESTURE_SPECS[seat.assignment.gestureId].instruction}</div>
        <div className="paddle-progress-track">
          <div
            className="paddle-progress-fill"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>
      </div>
    </main>
  );
};
