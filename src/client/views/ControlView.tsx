import React, { useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import {
  GAME_DEFAULTS,
  MAX_TEAM_SIZE_LIMIT,
  MAX_TOTAL_PLAYERS,
  MIN_TEAM_SIZE_LIMIT,
} from '../../shared/constants.js';
import type {
  AckResponse,
  HostCommandPayload,
  HostPrivateSnapshot,
  NetworkPresentationMode,
} from '../../shared/types.js';
import { createPondSocket, makeCommandId } from '../socketClient.js';

const HOST_AUTH_SESSION_KEY = 'cs260b_host_passcode';

type StagedTargetOption =
  | 'training'
  | 'straight'
  | 'freewater_practice'
  | 'freewater_scored';

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
  const [phaseChoice, setPhaseChoice] = useState<StagedTargetOption>('training');
  const [durationDraftSec, setDurationDraftSec] = useState<number>(GAME_DEFAULTS.straightRaceDurationSec);
  const [pendingStartOverride, setPendingStartOverride] = useState(false);
  const [confirmClearModal, setConfirmClearModal] = useState(false);

  // Universal team size range (teams & creature sizes configure automatically as players join)
  const [minTeamSizeDraft, setMinTeamSizeDraft] = useState<number>(GAME_DEFAULTS.defaultMinTeamSize);
  const [maxTeamSizeDraft, setMaxTeamSizeDraft] = useState<number>(GAME_DEFAULTS.defaultMaxTeamSize);
  const lastSyncedBoundsRef = useRef({ min: 0, max: 0 });

  const socketRef = useRef<Socket | null>(null);

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
      if (next.session.round.durationSec > 0) {
        setDurationDraftSec(next.session.round.durationSec);
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
    if (phaseChoice === 'training') {
      sendCommand((commandId) => ({
        commandId,
        type: 'load_phase',
        phase: 'training',
        scoringEnabled: false,
      }));
    } else if (phaseChoice === 'straight') {
      sendCommand((commandId) => ({
        commandId,
        type: 'load_phase',
        phase: 'straight',
        scoringEnabled: true,
        durationSec: GAME_DEFAULTS.straightRaceDurationSec,
      }));
    } else if (phaseChoice === 'freewater_practice') {
      sendCommand((commandId) => ({
        commandId,
        type: 'load_phase',
        phase: 'freewater',
        scoringEnabled: false,
        durationSec: GAME_DEFAULTS.freewaterPracticeDurationSec,
      }));
    } else {
      sendCommand((commandId) => ({
        commandId,
        type: 'load_phase',
        phase: 'freewater',
        scoringEnabled: true,
        durationSec: GAME_DEFAULTS.freewaterScoredDurationSec,
      }));
    }
  };

  const canChangeModeOrDuration =
    session.runStatus === 'ready' ||
    session.runStatus === 'paused' ||
    session.runStatus === 'finished';

  return (
    <main className="control-shell">
      {/* Top Status & Quick Links */}
      <header className="screen-header">
        <div className="screen-title-group">
          <h1 className="screen-title">Mission Control</h1>
          <span className="pill pill-ready">Phase: {session.phase}</span>
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
          <span className="pill">
            Active: {formatClock(session.round.activeElapsedMs)}
            {session.round.durationSec > 0
              ? ` · Rem: ${formatClock(session.round.remainingMs)}`
              : ''}
          </span>
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
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <select
                className="field-select"
                style={{ flex: 1 }}
                value={phaseChoice}
                onChange={(e) => setPhaseChoice(e.target.value as StagedTargetOption)}
                aria-label="Select phase to stage"
              >
                <option value="training">Training (Team Card Grid)</option>
                <option value="straight">Game 1: Straight Swim Race (90s)</option>
                <option value="freewater_practice">Game 2 Prep: Free-Water Practice (20s)</option>
                <option value="freewater_scored">Game 2: Scored Pond Harvest (90s)</option>
              </select>
              <button
                type="button"
                className="btn-secondary"
                style={{ flexShrink: 0, whiteSpace: 'nowrap' }}
                onClick={handleLoadSelectedPhase}
              >
                Load Phase
              </button>
            </div>

            <div className="btn-row">
              {session.runStatus === 'ready' && session.phase !== 'lobby' && (
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
                  Start {session.phase === 'training' ? 'Training' : 'Round'}
                </button>
              )}

              {(session.runStatus === 'running' || session.runStatus === 'countdown') && (
                <>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() =>
                      sendCommand((commandId) => ({
                        commandId,
                        type: 'pause_phase',
                        forDiscussion: false,
                      }))
                    }
                  >
                    Pause
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() =>
                      sendCommand((commandId) => ({
                        commandId,
                        type: 'pause_phase',
                        forDiscussion: true,
                      }))
                    }
                  >
                    Pause for Discussion
                  </button>
                </>
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

              {session.phase !== 'lobby' && session.runStatus !== 'finished' && (
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

            {/* Round Duration Control (editable while staged or paused) */}
            {(session.phase === 'straight' || session.phase === 'freewater') && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', flexWrap: 'wrap' }}>
                <label htmlFor="round-dur-input" style={{ fontSize: '0.86rem' }}>
                  Duration (s):
                </label>
                <input
                  id="round-dur-input"
                  type="number"
                  min={15}
                  max={300}
                  className="field-input"
                  style={{ width: 88, padding: '0.32rem 0.5rem' }}
                  disabled={!canChangeModeOrDuration}
                  value={durationDraftSec}
                  onChange={(e) => setDurationDraftSec(Number(e.target.value))}
                />
                <button
                  type="button"
                  className="btn-subtle btn-xs"
                  disabled={!canChangeModeOrDuration}
                  onClick={() =>
                    sendCommand((commandId) => ({
                      commandId,
                      type: 'set_round_duration',
                      durationSec: durationDraftSec,
                    }))
                  }
                >
                  Apply Duration
                </button>
                {session.phase === 'freewater' && session.round.scoringEnabled && (
                  <button
                    type="button"
                    className="btn-subtle btn-xs"
                    disabled={!canChangeModeOrDuration}
                    onClick={() => {
                      setDurationDraftSec(60);
                      sendCommand((commandId) => ({
                        commandId,
                        type: 'set_round_duration',
                        durationSec: 60,
                      }));
                    }}
                  >
                    60s Preset
                  </button>
                )}
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
                  disabled={!canChangeModeOrDuration}
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
                    disabled={
                      (session.phase === 'straight' ||
                        (session.phase === 'freewater' && session.round.scoringEnabled)) &&
                      (session.runStatus === 'running' || session.runStatus === 'countdown')
                    }
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
                    disabled={
                      (session.phase === 'straight' ||
                        (session.phase === 'freewater' && session.round.scoringEnabled)) &&
                      (session.runStatus === 'running' || session.runStatus === 'countdown')
                    }
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

              {(session.phase === 'straight' || session.phase === 'freewater') && (
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
                          <tr key={p.playerId}>
                            <td>
                              <strong>{p.limbLabel}</strong>
                              {p.held ? ' (Held)' : ''}
                            </td>
                            <td>{p.gestureInstruction}</td>
                            <td>
                              {p.connected ? 'Online' : 'Offline'} · {p.sensorStatus}
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
