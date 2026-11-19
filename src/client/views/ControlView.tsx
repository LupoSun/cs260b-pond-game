import React, { useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import {
  GAME_DEFAULTS,
  GUIDE_STEPS,
  MAX_TEAM_SIZE_LIMIT,
  MUSIC_VOLUME_DEFAULT,
  MAX_TOTAL_PLAYERS,
  MIN_TEAM_SIZE_LIMIT,
  describePhase,
  SECTION_LABELS,
  formatSectionClock,
} from '../../shared/constants.js';
import type {
  AckResponse,
  HostCommandPayload,
  HostPrivateSnapshot,
  NetworkPresentationMode,
  SectionId,
} from '../../shared/types.js';
import { createPondSocket, makeCommandId } from '../socketClient.js';

const HOST_AUTH_SESSION_KEY = 'cs260b_host_passcode';

type LoadPhaseArgs = Omit<Extract<HostCommandPayload, { type: 'load_phase' }>, 'commandId' | 'type'>;

function formatLimit(sec: number): string {
  return sec % 60 === 0 ? `${sec / 60} min` : `${sec}s`;
}

/**
 * The session in running order. `section` names the step's slot in the session plan; its planned
 * time is shown beside the label from the live server values. Nothing is sent with the load
 * command: the server starts that section's clock, which ends Game 1 and Game 2 at zero.
 * `load: null` is the how-to-play guide, an overlay rather than a phase.
 */
const SESSION_STEPS: ReadonlyArray<{
  id: string;
  label: string;
  section: SectionId | null;
  load: LoadPhaseArgs | null;
}> = [
  { id: 'guide', label: 'Explanation: How to Play', section: 'joining', load: null },
  { id: 'training', label: 'Training (Team Card Grid)', section: 'training', load: { phase: 'training' } },
  {
    id: 'straight_practice',
    label: 'Game 1 Prep: Straight Swim Practice',
    section: 'game1_prep',
    load: { phase: 'straight', scoringEnabled: false },
  },
  {
    id: 'discussion_before_game1',
    label: 'Discussion: What Makes You Fast?',
    section: 'discussion_before_game1',
    load: { phase: 'discussion', discussionTopic: 'before_game1' },
  },
  {
    id: 'straight',
    label: 'Game 1: Straight Swim Race',
    section: 'game1',
    load: { phase: 'straight', scoringEnabled: true },
  },
  {
    id: 'discussion_after_game1',
    label: 'Discussion: After Game 1',
    section: 'discussion_after_game1',
    load: { phase: 'discussion', discussionTopic: 'after_game1' },
  },
  {
    id: 'freewater_practice',
    label: 'Game 2 Prep: Free-Water Practice',
    section: 'game2_prep',
    load: { phase: 'freewater', scoringEnabled: false },
  },
  {
    id: 'freewater_scored',
    label: 'Game 2: Scored Pond Harvest',
    section: 'game2',
    load: { phase: 'freewater', scoringEnabled: true },
  },
  { id: 'leaderboard', label: 'Leaderboard: Session Results', section: null, load: { phase: 'leaderboard' } },
];

function formatClock(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Private Facilitator Mission Control (/control, Sections 4 & 9).
 * Protected by server-validated passcode on every command.
 */
export const ControlView: React.FC = () => {
  const [connected, setConnected] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [passcodeInput, setPasscodeInput] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [hostSnap, setHostSnap] = useState<HostPrivateSnapshot | null>(null);
  const [feedbackBanner, setFeedbackBanner] = useState<{ ok: boolean; text: string } | null>(null);

  // Controls form state
  const [phaseChoice, setPhaseChoice] = useState<string>(SESSION_STEPS[0].id);
  // Planned time for the section on screen, edited as minutes and seconds
  const [budgetDraft, setBudgetDraft] = useState<{ section: SectionId | null; min: number; sec: number }>({
    section: null,
    min: 0,
    sec: 0,
  });
  const lastSyncedBudgetRef = useRef<{ section: SectionId | null; budgetSec: number }>({ section: null, budgetSec: -1 });
  const [pendingStartOverride, setPendingStartOverride] = useState(false);
  const [confirmClearModal, setConfirmClearModal] = useState(false);

  // Universal team size range (teams & creature sizes configure automatically as players join)
  const [minTeamSizeDraft, setMinTeamSizeDraft] = useState<number>(GAME_DEFAULTS.defaultMinTeamSize);
  const [maxTeamSizeDraft, setMaxTeamSizeDraft] = useState<number>(GAME_DEFAULTS.defaultMaxTeamSize);
  const lastSyncedBoundsRef = useRef({ min: 0, max: 0 });

  const socketRef = useRef<Socket | null>(null);

  // Music volume slider (0..100)
  const [volumeDraft, setVolumeDraft] = useState<number>(MUSIC_VOLUME_DEFAULT);
  const volumeEditedAtMsRef = useRef(Number.NEGATIVE_INFINITY);
  const lastVolumeSendMsRef = useRef(0);
  const volumeTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const sock = createPondSocket();
    socketRef.current = sock;

    const tryAutoAuth = () => {
      const saved = window.sessionStorage.getItem(HOST_AUTH_SESSION_KEY);
      if (!saved) return;
      sock.emit('host.auth', { passcode: saved }, (res: AckResponse) => {
        if (res?.ok) {
          setAuthenticated(true);
          setAuthError(null);
        }
      });
    };

    sock.on('connect', () => {
      setConnected(true);
      tryAutoAuth();
    });
    sock.on('disconnect', () => setConnected(false));

    sock.on('host.snapshot', (next: HostPrivateSnapshot) => {
      setHostSnap(next);
      // Follow the server's volume (another host tab may move it), but not while this slider is being dragged
      if (performance.now() - volumeEditedAtMsRef.current > 700) {
        setVolumeDraft(next.session.musicVolume);
      }
      // Refill the planned-time fields only when the section or its saved value changes, never while typing
      const clock = next.session.sectionClock;
      if (
        lastSyncedBudgetRef.current.section !== clock.section ||
        lastSyncedBudgetRef.current.budgetSec !== clock.budgetSec
      ) {
        lastSyncedBudgetRef.current = { section: clock.section, budgetSec: clock.budgetSec };
        setBudgetDraft({
          section: clock.section,
          min: Math.floor(clock.budgetSec / 60),
          sec: clock.budgetSec % 60,
        });
      }
      if (
        lastSyncedBoundsRef.current.min !== next.session.minTeamSize ||
        lastSyncedBoundsRef.current.max !== next.session.maxTeamSize
      ) {
        lastSyncedBoundsRef.current = {
          min: next.session.minTeamSize,
          max: next.session.maxTeamSize,
        };
        setMinTeamSizeDraft(next.session.minTeamSize);
        setMaxTeamSizeDraft(next.session.maxTeamSize);
      }
    });

    return () => {
      sock.disconnect();
    };
  }, []);

  const handleAuthSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    const trimmed = passcodeInput.trim();
    if (!trimmed) return;
    socketRef.current?.emit('host.auth', { passcode: trimmed }, (res: AckResponse) => {
      if (res?.ok) {
        window.sessionStorage.setItem(HOST_AUTH_SESSION_KEY, trimmed);
        setAuthenticated(true);
      } else {
        setAuthError(res?.message || 'Authentication failed.');
      }
    });
  };

  const sendCommand = (
    builder: (commandId: string) => HostCommandPayload,
    onResult?: (res: AckResponse) => void,
  ) => {
    const sock = socketRef.current;
    if (!sock || !sock.connected) {
      setFeedbackBanner({ ok: false, text: 'Disconnected from server.' });
      return;
    }
    const payload = builder(makeCommandId('hcmd'));
    sock.emit('host.command', payload, (res: AckResponse) => {
      if (res.code === 'READINESS_WARNING_CONFIRM_REQUIRED') {
        setPendingStartOverride(true);
      } else {
        setPendingStartOverride(false);
      }
      setFeedbackBanner({ ok: res.ok, text: res.message });
      onResult?.(res);
    });
  };

  // Volume slider: the room hears the change while the thumb moves. Sends are spaced out and the
  // last value always goes; acknowledgements stay out of the feedback banner.
  const sendVolume = (volume: number) => {
    const sock = socketRef.current;
    if (!sock || !sock.connected) return;
    lastVolumeSendMsRef.current = performance.now();
    sock.emit('host.command', { commandId: makeCommandId('hvol'), type: 'set_music_volume', volume }, () => undefined);
  };
  const handleVolumeChange = (volume: number) => {
    setVolumeDraft(volume);
    volumeEditedAtMsRef.current = performance.now();
    if (volumeTimerRef.current !== null) window.clearTimeout(volumeTimerRef.current);
    const wait = Math.max(0, 90 - (performance.now() - lastVolumeSendMsRef.current));
    volumeTimerRef.current = window.setTimeout(() => {
      volumeTimerRef.current = null;
      sendVolume(volume);
    }, wait);
  };

  if (!authenticated) {
    return (
      <main className="play-shell" style={{ maxWidth: 440, justifyContent: 'center' }}>
        <section className="onboard-panel">
          <h1>Mission Control Sign-In</h1>
          <p>Enter the facilitator passcode (`HOST_PASSCODE`) to operate phases and inspect teams.</p>
          <form onSubmit={handleAuthSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <input
              type="password"
              className="field-input"
              placeholder="Facilitator passcode"
              value={passcodeInput}
              onChange={(e) => setPasscodeInput(e.target.value)}
              required
            />
            {authError && <div className="status-banner status-banner-warn">{authError}</div>}
            <button type="submit" className="btn-primary" disabled={!connected}>
              {connected ? 'Unlock Mission Control' : 'Connecting...'}
            </button>
          </form>
        </section>
      </main>
    );
  }

  if (!hostSnap) {
    return (
      <main className="control-shell">
        <div className="control-panel">Loading Mission Control state...</div>
      </main>
    );
  }

  const { session, players, readinessWarnings, eventLog } = hostSnap;
  const totalSeated = players.length;

  const baseOrigin =
    session.publicBaseUrl ||
    (typeof window !== 'undefined' ? window.location.origin : '');
  const playUrl = `${baseOrigin}/play`;
  const qrSrc = `/api/qr?url=${encodeURIComponent(playUrl)}`;

  const handleLoadSelectedPhase = () => {
    const step = SESSION_STEPS.find((st) => st.id === phaseChoice);
    if (!step) return;
    const { load } = step;
    if (load === null) {
      // Loading the Explanation starts it from the first card and starts its clock
      sendCommand((commandId) => ({ commandId, type: 'set_guide_visible', visible: true, fromStart: true }));
    } else {
      sendCommand((commandId) => ({ commandId, type: 'load_phase', ...load }));
    }
  };

  const isGamePhase = session.phase === 'straight' || session.phase === 'freewater';
  const isDisplayOnlyPhase = session.phase === 'discussion' || session.phase === 'leaderboard';
  const scoredRoundActive =
    isGamePhase &&
    session.round.scoringEnabled &&
    (session.runStatus === 'running' || session.runStatus === 'countdown');
  const phaseLabel = describePhase(session.phase, session.round.scoringEnabled);
  const sectionClock = session.sectionClock;
  const guideStep = Math.max(1, Math.min(GUIDE_STEPS.length, session.guideStep));
  const sendGuideStep = (step: number) =>
    sendCommand((commandId) => ({ commandId, type: 'set_guide_step', step }));
  const isScoredRound = isGamePhase && session.round.scoringEnabled;
  const sectionOver = sectionClock.section !== null && sectionClock.remainingMs <= 0;

  const canChangeNetworkMode =
    session.runStatus === 'ready' ||
    session.runStatus === 'paused' ||
    session.runStatus === 'finished';

  return (
    <main className="control-shell">
      {/* Top Status & Quick Links */}
      <header className="screen-header">
        <div className="screen-title-group">
          <h1 className="screen-title">Mission Control</h1>
          <span className="pill pill-ready">Phase: {phaseLabel}</span>
          {session.guideVisible && <span className="pill pill-running">Guide on screen</span>}
          {session.musicEnabled && <span className="pill pill-running">Music on</span>}
          {!isDisplayOnlyPhase && (
            <span
              className={`pill ${
                session.runStatus === 'running'
                  ? 'pill-running'
                  : session.runStatus === 'paused'
                    ? 'pill-paused'
                    : 'pill-ready'
              }`}
            >
              Status: {session.runStatus}
            </span>
          )}
          {sectionClock.section !== null && (
            <span className={`pill ${sectionOver ? 'pill-danger' : ''}`}>
              {SECTION_LABELS[sectionClock.section]}:{' '}
              {sectionClock.running
                ? `${formatSectionClock(sectionClock.remainingMs)}${sectionOver ? ' over' : ' left'}`
                : `${formatSectionClock(sectionClock.remainingMs)} (clock not started)`}
            </span>
          )}
          {isGamePhase && <span className="pill">Round time: {formatClock(session.round.activeElapsedMs)}</span>}
        </div>

        <div className="btn-row">
          <a
            href="/screen"
            target="_blank"
            rel="noopener noreferrer"
            className="btn-secondary btn-xs"
          >
            Open Classroom Display ↗
          </a>
          <a
            href="/lab"
            target="_blank"
            rel="noopener noreferrer"
            className="btn-subtle btn-xs"
          >
            Sensor Lab (/lab) ↗
          </a>
          <span className={`pill ${connected ? 'pill-running' : 'pill-danger'}`}>
            {connected ? 'Live' : 'Disconnected'}
          </span>
        </div>
      </header>

      {feedbackBanner && (
        <div
          className={`status-banner ${
            feedbackBanner.ok ? 'status-banner-accepted' : 'status-banner-warn'
          }`}
        >
          <span>{feedbackBanner.text}</span>
          <button
            type="button"
            className="btn-subtle btn-xs"
            onClick={() => setFeedbackBanner(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="control-grid">
        {/* LEFT COLUMN: Phase Deck, Network Mode, Admission & Scoped Resets */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <section className="control-panel">
            <h2>1. Phase &amp; Clock Controls</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <select
                className="field-select"
                style={{ width: '100%' }}
                value={phaseChoice}
                onChange={(e) => setPhaseChoice(e.target.value)}
                aria-label="Select phase to stage"
              >
                {SESSION_STEPS.map((st, i) => (
                  <option key={st.id} value={st.id}>
                    {i + 1}. {st.section ? `${formatLimit(session.sectionBudgetsSec[st.section])} · ` : ''}
                    {st.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn-secondary"
                style={{ alignSelf: 'flex-start', whiteSpace: 'nowrap' }}
                onClick={handleLoadSelectedPhase}
              >
                Load Phase
              </button>
            </div>

            <div className="btn-row">
              {session.runStatus === 'ready' && session.phase !== 'lobby' && !isDisplayOnlyPhase && (
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() =>
                    sendCommand((commandId) => ({
                      commandId,
                      type: 'start_phase',
                      overrideWarnings: false,
                    }))
                  }
                >
                  Start {phaseLabel}
                </button>
              )}

              {(session.runStatus === 'running' || session.runStatus === 'countdown') && (
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() =>
                    sendCommand((commandId) => ({
                      commandId,
                      type: 'pause_phase',
                    }))
                  }
                >
                  Pause
                </button>
              )}

              {session.runStatus === 'paused' && (
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() =>
                    sendCommand((commandId) => ({
                      commandId,
                      type: 'resume_phase',
                    }))
                  }
                >
                  Resume
                </button>
              )}

              {session.phase !== 'lobby' && !isDisplayOnlyPhase && session.runStatus !== 'finished' && (
                <button
                  type="button"
                  className="btn-subtle"
                  onClick={() =>
                    sendCommand((commandId) => ({
                      commandId,
                      type: 'end_round',
                    }))
                  }
                >
                  End Round
                </button>
              )}
            </div>

            {isDisplayOnlyPhase && (
              <p style={{ margin: 0, fontSize: '0.83rem', color: 'var(--ink-secondary)' }}>
                {phaseLabel} is showing on the classroom display. There is nothing to start; load the
                next phase when the room is ready.
              </p>
            )}

            {/* Readiness Warning Override Confirmation */}
            {pendingStartOverride && readinessWarnings.length > 0 && (
              <div className="status-banner status-banner-warn" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
                <strong>Readiness warnings detected before scored start:</strong>
                <ul style={{ margin: '0.35rem 0', paddingLeft: '1.2rem', fontSize: '0.83rem' }}>
                  {readinessWarnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
                <div className="btn-row">
                  <button
                    type="button"
                    className="btn-primary btn-xs"
                    onClick={() =>
                      sendCommand((commandId) => ({
                        commandId,
                        type: 'start_phase',
                        overrideWarnings: true,
                      }))
                    }
                  >
                    Override Warnings &amp; Start Countdown
                  </button>
                  <button
                    type="button"
                    className="btn-subtle btn-xs"
                    onClick={() => setPendingStartOverride(false)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* Section clock: ends the two scored games at zero, paces everything else */}
            {sectionClock.section !== null && (
              <div className="section-clock-control">
                <span style={{ fontSize: '0.86rem' }}>
                  Planned time for <strong>{SECTION_LABELS[sectionClock.section]}</strong>
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
                  <input
                    type="number"
                    min={0}
                    max={60}
                    className="field-input"
                    style={{ width: 62, padding: '0.32rem 0.5rem' }}
                    aria-label="Planned minutes"
                    value={budgetDraft.min}
                    onChange={(e) => setBudgetDraft((d) => ({ ...d, min: Number(e.target.value) }))}
                  />
                  <span style={{ fontSize: '0.86rem' }}>min</span>
                  <input
                    type="number"
                    min={0}
                    max={59}
                    className="field-input"
                    style={{ width: 62, padding: '0.32rem 0.5rem' }}
                    aria-label="Planned seconds"
                    value={budgetDraft.sec}
                    onChange={(e) => setBudgetDraft((d) => ({ ...d, sec: Number(e.target.value) }))}
                  />
                  <span style={{ fontSize: '0.86rem' }}>s</span>
                  <button
                    type="button"
                    className="btn-subtle btn-xs"
                    onClick={() => {
                      const section = sectionClock.section;
                      if (!section) return;
                      sendCommand((commandId) => ({
                        commandId,
                        type: 'set_section_budget',
                        section,
                        budgetSec: Math.round(budgetDraft.min) * 60 + Math.round(budgetDraft.sec),
                      }));
                    }}
                  >
                    Apply
                  </button>
                  <button
                    type="button"
                    className="btn-subtle btn-xs"
                    onClick={() =>
                      sendCommand((commandId) => ({
                        commandId,
                        type: 'restart_section_clock',
                      }))
                    }
                  >
                    {sectionClock.running ? 'Restart Clock' : 'Start Clock'}
                  </button>
                </div>
                <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--ink-secondary)' }}>
                  The clock starts when a phase is loaded
                  {session.phase === 'lobby' ? ' (here: when the first player joins, or when you press Start Clock)' : ''}.{' '}
                  {isScoredRound
                    ? 'At zero this game ends. Changing the planned time or restarting the clock moves that moment.'
                    : 'At zero it turns red and counts into the minus; this section does not end until you move on. Only Game 1 and Game 2 end at zero.'}
                </p>
              </div>
            )}
          </section>

          {/* 2. Network Presentation Mode */}
          <section className="control-panel">
            <h2>2. Network Presentation Mode</h2>
            <p style={{ margin: 0, fontSize: '0.83rem', color: 'var(--ink-secondary)' }}>
              Both modes award identical propulsion per accepted stroke. Continuous streams live limb
              previews (~16 Hz); Completed-Stroke sends only press/release and accepted strokes.
            </p>
            <div className="btn-row">
              {(['continuous', 'stroke_events'] as NetworkPresentationMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  disabled={!canChangeNetworkMode}
                  aria-pressed={session.networkMode === mode}
                  className={session.networkMode === mode ? 'btn-primary btn-xs' : 'btn-subtle btn-xs'}
                  onClick={() =>
                    sendCommand((commandId) => ({
                      commandId,
                      type: 'set_network_mode',
                      networkMode: mode,
                    }))
                  }
                >
                  {session.networkMode === mode ? '✓ ' : ''}
                  {mode === 'continuous' ? 'Continuous Limb Preview' : 'Completed-Stroke Events'}
                </button>
              ))}
            </div>
          </section>

          {/* 3. Admission, Join QR & Universal Team Size Range */}
          <section className="control-panel">
            <h2>3. Join QR, Admission &amp; Universal Team Size</h2>
            <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
              <img
                src={qrSrc}
                alt="Participant join QR"
                style={{
                  width: 92,
                  height: 92,
                  background: '#fff',
                  padding: 4,
                  borderRadius: 6,
                  border: '3px solid var(--border-strong)',
                }}
              />
              <div style={{ fontSize: '0.82rem' }}>
                <div style={{ fontWeight: 700, wordBreak: 'break-all' }}>{playUrl}</div>
                <div style={{ color: 'var(--ink-secondary)', margin: '0.25rem 0' }}>
                  Active Teams: <strong>{session.teams.length}</strong> · Seated:{' '}
                  <strong>{totalSeated}</strong> / {MAX_TOTAL_PLAYERS} cap
                </div>
                <button
                  type="button"
                  className="btn-subtle btn-xs"
                  onClick={() =>
                    sendCommand((commandId) => ({
                      commandId,
                      type: 'set_admission_lock',
                      locked: !session.admissionLocked,
                    }))
                  }
                >
                  {session.admissionLocked ? 'Unlock New Admission' : 'Lock New Admission'}
                </button>
              </div>
            </div>

            <div style={{ borderTop: '2px dashed var(--border-strong)', paddingTop: '0.7rem' }}>
              <div style={{ fontSize: '0.84rem', fontWeight: 650, marginBottom: '0.35rem' }}>
                How-to-Play Guide on Classroom Display
              </div>
              <p style={{ margin: '0 0 0.5rem', fontSize: '0.8rem', color: 'var(--ink-secondary)' }}>
                Covers the classroom display. A fresh session opens on its first card, The Game. Reveal
                the rest as you explain: steps 1 to 3, then the QR code once the class is ready to
                join. Loading step 1 (Explanation) in panel 1 starts it from the first card and starts
                the clock, which shows at the top right of the guide. It hides itself when you load,
                start, or resume a phase.
              </p>
              <div className="btn-row" style={{ alignItems: 'center' }}>
                <button
                  type="button"
                  aria-pressed={session.guideVisible}
                  className={session.guideVisible ? 'btn-primary btn-xs' : 'btn-secondary btn-xs'}
                  disabled={
                    !session.guideVisible &&
                    (session.runStatus === 'running' || session.runStatus === 'countdown')
                  }
                  onClick={() =>
                    sendCommand((commandId) => ({
                      commandId,
                      type: 'set_guide_visible',
                      visible: !session.guideVisible,
                    }))
                  }
                >
                  {session.guideVisible ? 'Hide Guide' : 'Show Guide'}
                </button>
                <span className={`pill ${session.guideVisible ? 'pill-running' : ''}`}>
                  {session.guideVisible ? 'Guide showing' : 'Guide hidden'}
                </span>
              </div>
              <div className="guide-stepper">
                <div className="guide-stepper-now">
                  On screen{session.guideVisible ? '' : ' when shown'}: step {guideStep} of {GUIDE_STEPS.length},{' '}
                  <strong>{GUIDE_STEPS[guideStep - 1].label}</strong>
                </div>
                <div className="btn-row" style={{ alignItems: 'center' }}>
                  <button
                    type="button"
                    className="btn-subtle btn-xs"
                    disabled={guideStep <= 1}
                    onClick={() => sendGuideStep(guideStep - 1)}
                  >
                    ◀ Back
                  </button>
                  <button
                    type="button"
                    className="btn-primary btn-xs"
                    disabled={guideStep >= GUIDE_STEPS.length}
                    onClick={() => sendGuideStep(guideStep + 1)}
                  >
                    {guideStep >= GUIDE_STEPS.length
                      ? 'Everything is showing'
                      : `Next: ${GUIDE_STEPS[guideStep].label} ▶`}
                  </button>
                </div>
                <ol className="guide-stepper-list">
                  {GUIDE_STEPS.map((gs, i) => (
                    <li key={gs.id}>
                      <button
                        type="button"
                        className={`guide-stepper-item ${i + 1 <= guideStep ? 'is-shown' : ''} ${
                          i + 1 === guideStep ? 'is-current' : ''
                        }`}
                        aria-current={i + 1 === guideStep ? 'step' : undefined}
                        onClick={() => sendGuideStep(i + 1)}
                      >
                        <span aria-hidden="true">{i + 1 <= guideStep ? '✓' : i + 1}</span> {gs.label}
                      </button>
                    </li>
                  ))}
                </ol>
              </div>
            </div>

            <div style={{ borderTop: '2px dashed var(--border-strong)', paddingTop: '0.7rem' }}>
              <div style={{ fontSize: '0.84rem', fontWeight: 650, marginBottom: '0.35rem' }}>
                Background Music on Classroom Display
              </div>
              <p style={{ margin: '0 0 0.5rem', fontSize: '0.8rem', color: 'var(--ink-secondary)' }}>
                Party-style music from the classroom display's speakers: a lounge loop between
                rounds, livelier loops during training, prep and the games, silence during discussions.
                Phones stay quiet. The display's browser needs one click on its page before it is
                allowed to play sound; it shows a button when it is waiting for that.
              </p>
              <div className="btn-row" style={{ alignItems: 'center' }}>
                <button
                  type="button"
                  aria-pressed={session.musicEnabled}
                  className={session.musicEnabled ? 'btn-primary btn-xs' : 'btn-secondary btn-xs'}
                  onClick={() =>
                    sendCommand((commandId) => ({
                      commandId,
                      type: 'set_music_enabled',
                      enabled: !session.musicEnabled,
                    }))
                  }
                >
                  {session.musicEnabled ? 'Turn Music Off' : 'Turn Music On'}
                </button>
                <span className={`pill ${session.musicEnabled ? 'pill-running' : ''}`}>
                  {session.musicEnabled ? 'Music on' : 'Music off'}
                </span>
              </div>
              <div className="music-volume-row">
                <label htmlFor="music-volume-slider">Volume</label>
                <input
                  id="music-volume-slider"
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={volumeDraft}
                  onChange={(e) => handleVolumeChange(Number(e.target.value))}
                />
                <output htmlFor="music-volume-slider">{volumeDraft}%</output>
              </div>
            </div>

            <div style={{ borderTop: '2px dashed var(--border-strong)', paddingTop: '0.7rem' }}>
              <div style={{ fontSize: '0.84rem', fontWeight: 650, marginBottom: '0.35rem' }}>
                Universal Team Size Range (Auto-configures per joined team)
              </div>
              <p style={{ margin: '0 0 0.5rem', fontSize: '0.8rem', color: 'var(--ink-secondary)' }}>
                Teams appear automatically as participants join (1–{session.maxTeamNumber}) and
                size their paddles to who joined within [{session.minTeamSize}–{session.maxTeamSize}].
              </p>
              <div className="btn-row" style={{ alignItems: 'center' }}>
                <label style={{ fontSize: '0.82rem', display: 'flex', alignItems: 'center', gap: 5 }}>
                  Min:
                  <select
                    className="field-select"
                    style={{ padding: '0.24rem 0.45rem', fontSize: '0.85rem' }}
                    value={minTeamSizeDraft}
                    disabled={scoredRoundActive}
                    onChange={(e) => {
                      const nextMin = Number(e.target.value);
                      setMinTeamSizeDraft(nextMin);
                      if (maxTeamSizeDraft < nextMin) {
                        setMaxTeamSizeDraft(nextMin);
                      }
                    }}
                  >
                    {Array.from(
                      { length: MAX_TEAM_SIZE_LIMIT - MIN_TEAM_SIZE_LIMIT + 1 },
                      (_, i) => MIN_TEAM_SIZE_LIMIT + i,
                    ).map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>

                <label style={{ fontSize: '0.82rem', display: 'flex', alignItems: 'center', gap: 5 }}>
                  Max:
                  <select
                    className="field-select"
                    style={{ padding: '0.24rem 0.45rem', fontSize: '0.85rem' }}
                    value={maxTeamSizeDraft}
                    disabled={scoredRoundActive}
                    onChange={(e) => {
                      const nextMax = Number(e.target.value);
                      setMaxTeamSizeDraft(nextMax);
                      if (minTeamSizeDraft > nextMax) {
                        setMinTeamSizeDraft(nextMax);
                      }
                    }}
                  >
                    {Array.from(
                      { length: MAX_TEAM_SIZE_LIMIT - MIN_TEAM_SIZE_LIMIT + 1 },
                      (_, i) => MIN_TEAM_SIZE_LIMIT + i,
                    ).map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>

                <button
                  type="button"
                  className={
                    minTeamSizeDraft !== session.minTeamSize ||
                    maxTeamSizeDraft !== session.maxTeamSize
                      ? 'btn-primary btn-xs'
                      : 'btn-secondary btn-xs'
                  }
                  disabled={
                    minTeamSizeDraft === session.minTeamSize &&
                    maxTeamSizeDraft === session.maxTeamSize
                  }
                  onClick={() =>
                    sendCommand((commandId) => ({
                      commandId,
                      type: 'set_team_size_bounds',
                      minTeamSize: minTeamSizeDraft,
                      maxTeamSize: maxTeamSizeDraft,
                    }))
                  }
                >
                  Apply Size Range
                </button>
              </div>
            </div>
          </section>

          {/* 4. Scoped Recovery & Reset Controls (Section 9) */}
          <section className="control-panel">
            <h2>4. Scoped Recovery &amp; Resets</h2>
            <div className="btn-row">
              <button
                type="button"
                className="btn-subtle btn-xs"
                onClick={() =>
                  sendCommand((commandId) => ({
                    commandId,
                    type: 'reset_practice_all',
                  }))
                }
              >
                Reset Practice: All Teams (Keep Cal &amp; Seats)
              </button>

              {isGamePhase && (
                <button
                  type="button"
                  className="btn-subtle btn-xs"
                  onClick={() =>
                    sendCommand((commandId) => ({
                      commandId,
                      type: 'reset_scored_round',
                    }))
                  }
                >
                  Reset Current Round to Ready (Keep Players)
                </button>
              )}
            </div>

            {!confirmClearModal ? (
              <button
                type="button"
                className="btn-danger btn-xs"
                style={{ alignSelf: 'flex-start' }}
                onClick={() => setConfirmClearModal(true)}
              >
                Clear Entire Session (Evicts All Players)...
              </button>
            ) : (
              <div className="status-banner status-banner-warn" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
                <strong>Confirm Clear Entire Session?</strong>
                <span style={{ fontSize: '0.82rem' }}>
                  This clears all team rosters, limb assignments, calibrations, and scores. Every
                  student will have to scan and rejoin.
                </span>
                <div className="btn-row">
                  <button
                    type="button"
                    className="btn-danger btn-xs"
                    onClick={() => {
                      setConfirmClearModal(false);
                      sendCommand((commandId) => ({
                        commandId,
                        type: 'clear_session',
                        confirmClearSession: true,
                      }));
                    }}
                  >
                    Yes, Clear Entire Session
                  </button>
                  <button
                    type="button"
                    className="btn-subtle btn-xs"
                    onClick={() => setConfirmClearModal(false)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>

        {/* RIGHT COLUMN: Team & Per-Player Inspection + Event Log */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <section className="control-panel">
            <h2>Team &amp; Limb Readiness Inspection</h2>
            <p style={{ margin: 0, fontSize: '0.83rem', color: 'var(--ink-secondary)' }}>
              Connected, sensor-ready, calibrated, and accepted-stroke states are tracked
              independently so you can spot any participant needing help at a glance.
            </p>

            {session.teams.length === 0 ? (
              <div
                style={{
                  border: '2px dashed var(--border-strong)',
                  borderRadius: '8px',
                  padding: '1rem',
                  background: 'var(--bg-surface-raised)',
                  color: 'var(--ink-secondary)',
                  fontSize: '0.88rem',
                }}
              >
                No teams have joined yet. Share the QR code or <code>{playUrl}</code>; teams spawn
                automatically as participants enter their team number (range{' '}
                {session.minTeamSize}–{session.maxTeamSize} players per team).
              </div>
            ) : (
              session.teams.map((team) => {
                const teamPlayers = players.filter((p) => p.teamNumber === team.teamNumber);
                const belowMin = team.limbCount < team.minSeats;
                const atMax = team.limbCount >= team.maxSeats;
                return (
                  <div
                    key={team.teamNumber}
                    style={{
                      border: '2px solid var(--border-strong)',
                      borderRadius: '8px',
                      padding: '0.75rem',
                      background: 'var(--bg-surface-raised)',
                      overflowX: 'auto',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        flexWrap: 'wrap',
                        gap: '0.5rem',
                        marginBottom: '0.5rem',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                        <span
                          className="team-swatch-dot"
                          style={{ backgroundColor: team.colorHex }}
                        />
                        <strong>
                          Team {team.teamNumber} · {team.teamName}
                        </strong>
                        <span
                          className={`pill ${
                            belowMin ? 'pill-paused' : atMax ? 'pill-running' : 'pill-ready'
                          }`}
                        >
                          {belowMin
                            ? `${team.limbCount} joined · min ${team.minSeats}`
                            : atMax
                              ? `${team.limbCount} limbs · Full`
                              : `${team.limbCount} ${team.limbCount === 1 ? 'limb' : 'limbs'} (max ${team.maxSeats})`}
                        </span>
                        <span className="pill">Online {team.connectedCount}</span>
                        <span className="pill">Cal {team.calibratedCount}</span>
                        <span className="pill">Practiced {team.practicedCount}</span>
                      </div>

                      <button
                        type="button"
                        className="btn-subtle btn-xs"
                        onClick={() =>
                          sendCommand((commandId) => ({
                            commandId,
                            type: 'reset_practice_team',
                            teamNumber: team.teamNumber,
                          }))
                        }
                      >
                        Reset Team {team.teamNumber} Practice
                      </button>
                    </div>

                    <table className="diag-table">
                      <thead>
                        <tr>
                          <th>Limb</th>
                          <th>Assigned Motion</th>
                          <th>Conn / Sensor</th>
                          <th>Calibrated</th>
                          <th>Strokes</th>
                          <th>Method / RTT</th>
                          <th>Last Result / Age</th>
                          <th>Scoped Fix</th>
                        </tr>
                      </thead>
                      <tbody>
                        {teamPlayers.map((p) => (
                          <tr key={p.playerId} style={p.seated ? undefined : { opacity: 0.55 }}>
                            <td>
                              <span aria-hidden="true">{p.playerEmoji}</span> <strong>{p.playerName}</strong> · {p.limbLabel}
                              {p.held ? ' (Held)' : ''}
                            </td>
                            <td>{p.gestureInstruction}</td>
                            <td>
                              {p.connected
                                ? 'Online'
                                : p.seated
                                  ? 'Offline (limb held briefly)'
                                  : 'Away (returns on reconnect)'}{' '}
                              · {p.sensorStatus}
                            </td>
                            <td>{p.calibrated ? `Yes (v${p.calibrationVersion})` : 'No'}</td>
                            <td>
                              {p.hasSucceededStroke ? `✓ (${p.practiceAcceptedCount})` : '0'}
                            </td>
                            <td>
                              {p.inputMethod}
                              {p.measuredRttMs !== null ? ` · ${p.measuredRttMs}ms` : ''}
                            </td>
                            <td>
                              {p.lastRecognitionResult}
                              {p.lastAcceptedStrokeAgeMs !== null
                                ? ` (${Math.round(p.lastAcceptedStrokeAgeMs / 1000)}s ago)`
                                : ''}
                            </td>
                            <td>
                              <div className="btn-row" style={{ gap: '0.25rem' }}>
                                <button
                                  type="button"
                                  className="btn-subtle btn-xs"
                                  onClick={() =>
                                    sendCommand((commandId) => ({
                                      commandId,
                                      type: 'release_player_input',
                                      playerId: p.playerId,
                                    }))
                                  }
                                >
                                  Release Hold
                                </button>
                                <button
                                  type="button"
                                  className="btn-subtle btn-xs"
                                  onClick={() =>
                                    sendCommand((commandId) => ({
                                      commandId,
                                      type: 'recalibrate_player',
                                      playerId: p.playerId,
                                    }))
                                  }
                                >
                                  Recalibrate
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              })
            )}
          </section>

          {/* Session Event Log */}
          <section className="control-panel">
            <h2>Session Event Log</h2>
            <div
              style={{
                maxHeight: 200,
                overflowY: 'auto',
                fontSize: '0.8rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.25rem',
              }}
            >
              {eventLog.map((e) => (
                <div
                  key={e.id}
                  style={{
                    color: e.level === 'warn' ? 'var(--ink-warn)' : 'var(--ink-secondary)',
                  }}
                >
                  <code>{e.atIso.slice(11, 19)}</code> · {e.message}
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
};
