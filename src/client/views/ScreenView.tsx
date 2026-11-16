import React, { useEffect, useRef, useState } from 'react';
import type {
  ItemCollectedBroadcast,
  SessionPublicSnapshot,
  StrokeAcceptedBroadcast,
  TeamPublicState,
} from '../../shared/types.js';
import { ComicBurst } from '../components/ComicBurst.js';
import { CreatureCardCanvas } from '../components/CreatureCardCanvas.js';
import { FeedbackController } from '../feedback.js';
import {
  drawFreewaterScene,
  drawStraightRaceScene,
  type TransientVisualEffects,
} from '../pondRenderer.js';
import { createPondSocket } from '../socketClient.js';

function formatClock(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function computeDynamicGridShape(teamCount: number): { cols: number; rows: number } {
  if (teamCount <= 1) return { cols: 1, rows: 1 };
  if (teamCount === 2) return { cols: 2, rows: 1 };
  if (teamCount === 3) return { cols: 3, rows: 1 };
  if (teamCount === 4) return { cols: 2, rows: 2 };
  if (teamCount <= 6) return { cols: 3, rows: 2 };
  if (teamCount <= 8) return { cols: 4, rows: 2 };
  if (teamCount === 9) return { cols: 3, rows: 3 };
  if (teamCount <= 12) return { cols: 4, rows: 3 };
  return { cols: 5, rows: Math.ceil(teamCount / 5) };
}

/**
 * Read-only Classroom Projector Display (/screen, Section 5).
 * Strictly exposes zero administrative actions, reset buttons, or credentials.
 */
export const ScreenView: React.FC = () => {
  const [snapshot, setSnapshot] = useState<SessionPublicSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [showQrDrawer, setShowQrDrawer] = useState(false);
  const [muted, setMuted] = useState(false);

  const arenaCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const snapRef = useRef<SessionPublicSnapshot | null>(null);
  const feedbackRef = useRef(new FeedbackController());

  // Deduplicated visual effect caches (prevent replaying old flashes on reconnect, Section 12.5)
  const seenStrokeIdsRef = useRef(new Set<string>());
  const seenItemAwardsRef = useRef(new Set<string>());
  const effectsRef = useRef<TransientVisualEffects>({
    limbAcceptedFlashAtMs: new Map(),
    itemPops: new Map(),
  });

  // Smooth visual position interpolation state (presentation only; never predicts scores/awards!)
  const interpSimRef = useRef(
    new Map<number, { x: number; y: number; headingRad: number; laneProgress: number }>(),
  );

  useEffect(() => {
    const sock = createPondSocket();

    sock.on('connect', () => setConnected(true));
    sock.on('disconnect', () => setConnected(false));

    sock.on('session.snapshot', (nextSnap: SessionPublicSnapshot) => {
      const prev = snapRef.current;
      if (prev && prev.sessionId === nextSnap.sessionId && nextSnap.stateRevision < prev.stateRevision) {
        return;
      }
      if (prev && prev.round.roundId !== nextSnap.round.roundId) {
        interpSimRef.current.clear();
        effectsRef.current.itemPops.clear();
      }
      snapRef.current = nextSnap;
      setSnapshot(nextSnap);
    });

    sock.on('stroke.accepted', (ev: StrokeAcceptedBroadcast) => {
      if (seenStrokeIdsRef.current.has(ev.strokeId)) return;
      seenStrokeIdsRef.current.add(ev.strokeId);
      if (seenStrokeIdsRef.current.size > 2000) {
        const first = seenStrokeIdsRef.current.values().next().value;
        if (first) seenStrokeIdsRef.current.delete(first);
      }
      effectsRef.current.limbAcceptedFlashAtMs.set(
        `${ev.teamNumber}:${ev.limbIndex}`,
        performance.now(),
      );
    });

    sock.on('item.collected', (ev: ItemCollectedBroadcast) => {
      const awardKey = `${ev.roundId}:${ev.itemId}:${ev.atServerMs}`;
      if (seenItemAwardsRef.current.has(awardKey)) return;
      seenItemAwardsRef.current.add(awardKey);

      const team = snapRef.current?.teams.find((t) => t.teamNumber === ev.teamNumber);
      effectsRef.current.itemPops.set(awardKey, {
        x: ev.x,
        y: ev.y,
        colorHex: team?.colorHex ?? '#ffd166',
        atMs: performance.now(),
      });
      feedbackRef.current.playTone('collected');
    });

    return () => {
      sock.disconnect();
    };
  }, []);

  // Arena 60fps render loop for Straight Race & Free-Water phases
  useEffect(() => {
    let rafId = 0;
    const reducedMotion = FeedbackController.prefersReducedMotion();

    const loop = (nowMs: number) => {
      const curSnap = snapRef.current;
      const canvas = arenaCanvasRef.current;
      if (curSnap && canvas && (curSnap.phase === 'straight' || curSnap.phase === 'freewater')) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          // Smooth client visual interpolation toward authoritative snapshot coordinates
          const interpTeams: TeamPublicState[] = curSnap.teams.map((t) => {
            const prev = interpSimRef.current.get(t.teamNumber);
            if (!prev || reducedMotion || curSnap.runStatus !== 'running') {
              const exact = {
                x: t.sim.x,
                y: t.sim.y,
                headingRad: t.sim.headingRad,
                laneProgress: t.sim.laneProgress,
              };
              interpSimRef.current.set(t.teamNumber, exact);
              return t;
            }

            const alpha = 0.28;
            const dAngle = Math.atan2(
              Math.sin(t.sim.headingRad - prev.headingRad),
              Math.cos(t.sim.headingRad - prev.headingRad),
            );
            const next = {
              x: prev.x + (t.sim.x - prev.x) * alpha,
              y: prev.y + (t.sim.y - prev.y) * alpha,
              headingRad: prev.headingRad + dAngle * alpha,
              laneProgress: prev.laneProgress + (t.sim.laneProgress - prev.laneProgress) * alpha,
            };
            interpSimRef.current.set(t.teamNumber, next);
            return {
              ...t,
              sim: {
                ...t.sim,
                x: next.x,
                y: next.y,
                headingRad: next.headingRad,
                laneProgress: next.laneProgress,
              },
            };
          });

          const renderSnap: SessionPublicSnapshot = {
            ...curSnap,
            teams: interpTeams,
          };

          if (curSnap.phase === 'straight') {
            drawStraightRaceScene(ctx, renderSnap, nowMs, reducedMotion, effectsRef.current);
          } else {
            drawFreewaterScene(ctx, renderSnap, nowMs, reducedMotion, effectsRef.current);
          }
        }
      }
      rafId = window.requestAnimationFrame(loop);
    };

    rafId = window.requestAnimationFrame(loop);
    return () => window.cancelAnimationFrame(rafId);
  }, []);

  if (!snapshot) {
    return (
      <main className="screen-shell">
        <header className="screen-header">
          <h1 className="screen-title">CS260B Shared-Body Pond</h1>
          <span className="pill pill-paused">Connecting to session...</span>
        </header>
      </main>
    );
  }

  const baseOrigin =
    snapshot.publicBaseUrl ||
    (typeof window !== 'undefined' ? window.location.origin : '');
  const playUrl = `${baseOrigin}/play`;
  const qrSrc = `/api/qr?url=${encodeURIComponent(playUrl)}`;

  const phaseTitle =
    snapshot.phase === 'lobby'
      ? 'Lobby · Join Your Team'
      : snapshot.phase === 'training'
        ? 'Team Paddle Training'
        : snapshot.phase === 'straight'
          ? 'Game 1 · Straight Pond Race'
          : snapshot.round.scoringEnabled
            ? 'Game 2 · Free-Water Pond Harvest'
            : 'Free-Water Steering Practice (Unscored)';

  const timerDisplay =
    snapshot.phase === 'lobby'
      ? `${snapshot.teams.reduce((s, t) => s + t.joinedCount, 0)} Seated · ${snapshot.teams.length} ${
          snapshot.teams.length === 1 ? 'Team' : 'Teams'
        }`
      : snapshot.round.durationSec > 0
        ? formatClock(snapshot.round.remainingMs)
        : formatClock(snapshot.round.activeElapsedMs);

  const countdownDigit = Math.max(1, Math.ceil(snapshot.round.countdownRemainingMs / 1000));
  const gridShape = computeDynamicGridShape(snapshot.teams.length);
  const gridVars = {
    '--grid-cols': gridShape.cols,
    '--grid-rows': gridShape.rows,
  } as React.CSSProperties;
  const sizeRangeText =
    snapshot.minTeamSize === snapshot.maxTeamSize
      ? `${snapshot.minTeamSize} players per team`
      : `${snapshot.minTeamSize}–${snapshot.maxTeamSize} players per team`;

  const populatedTeams = snapshot.teams.filter((t) => t.joinedCount > 0);
  const competingTeams = populatedTeams.length > 0 ? populatedTeams : snapshot.teams;

  const sortedResults = [...competingTeams].sort((a, b) => {
    const ra = a.sim.rank ?? 99;
    const rb = b.sim.rank ?? 99;
    if (ra !== rb) return ra - rb;
    return a.teamNumber - b.teamNumber;
  });

  return (
    <main className="screen-shell">
      {/* Compact Public Header (No admin controls!) */}
      <header className="screen-header">
        <div className="screen-title-group">
          <h1 className="screen-title">{phaseTitle}</h1>
          <span
            className={`pill ${
              snapshot.runStatus === 'running'
                ? 'pill-running'
                : snapshot.runStatus === 'paused'
                  ? 'pill-paused'
                  : 'pill-ready'
            }`}
          >
            {snapshot.runStatus === 'countdown'
              ? `Countdown ${Math.ceil(snapshot.round.countdownRemainingMs / 1000)}s`
              : snapshot.runStatus.toUpperCase()}
          </span>
          <span className="pill">
            {snapshot.networkMode === 'continuous' ? 'Live Limb Mode' : 'Completed-Stroke Mode'}
          </span>
        </div>

        <div className="screen-title-group">
          {snapshot.phase === 'freewater' && snapshot.round.scoringEnabled && (
            <div className="btn-row" style={{ gap: '0.4rem' }}>
              {competingTeams.map((t) => (
                <span key={t.teamNumber} className="pill" style={{ borderColor: t.colorHex }}>
                  <span className="team-swatch-dot" style={{ backgroundColor: t.colorHex, width: 10, height: 10 }} />
                  T{t.teamNumber}: {t.sim.score}
                </span>
              ))}
            </div>
          )}

          <div className="screen-clock" aria-label="Round timer">
            {timerDisplay}
          </div>

          {snapshot.phase !== 'lobby' && !snapshot.admissionLocked && (
            <button
              type="button"
              className="btn-subtle btn-xs"
              onClick={() => setShowQrDrawer((v) => !v)}
            >
              {showQrDrawer ? 'Hide Join QR' : 'Join QR'}
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
            {muted ? 'Sound Off' : 'Sound On'}
          </button>

          {!connected && <span className="pill pill-danger">Reconnecting</span>}
        </div>
      </header>

      {/* Expandable Corner QR Banner when outside Lobby (kept clear of active creatures) */}
      {showQrDrawer && snapshot.phase !== 'lobby' && (
        <aside className="qr-drawer">
          <div className="qr-image-frame">
            <img src={qrSrc} alt="Scan to join pond game" />
          </div>
          <div className="qr-drawer-url">{playUrl}</div>
        </aside>
      )}

      {/* 1. LOBBY VIEW: Only shows teams that have joined; cards resize & relayout dynamically */}
      {snapshot.phase === 'lobby' &&
        (snapshot.teams.length === 0 ? (
          <section className="lobby-empty-stage">
            <div className="qr-panel qr-panel-hero">
              <h2 className="comic-word">Scan to Join!</h2>
              {/* Sticker hangs off the panel corner so it can never cover the QR code */}
              <span className="qr-sticker" aria-hidden="true">
                <ComicBurst fill="#ff5aa5" seed={2} className="burst-wobble">
                  <span className="comic-word" style={{ '--word-fill': '#ffffff' } as React.CSSProperties}>
                    HEY!
                  </span>
                </ComicBurst>
              </span>
              <div className="qr-image-frame">
                <img src={qrSrc} alt={`Join QR code for ${playUrl}`} />
              </div>
              <div className="join-url-pill">{playUrl}</div>
              <span className="pill pill-ready">{sizeRangeText}</span>
              <p className="speech-bubble">
                Enter the <strong>Team Number</strong> assigned by your facilitator. Creatures
                appear and grow paddles automatically as teammates join!
              </p>
              {snapshot.admissionLocked && (
                <span className="pill pill-paused">Admission Locked (Rejoining Open)</span>
              )}
            </div>
          </section>
        ) : (
          <section className="lobby-layout">
            <div className="qr-panel">
              <h2 className="comic-word">Scan to Join!</h2>
              <div className="qr-image-frame">
                <img src={qrSrc} alt={`Join QR code for ${playUrl}`} />
              </div>
              <div className="join-url-pill">{playUrl}</div>
              <span className="pill pill-ready">{sizeRangeText}</span>
              <p className="speech-bubble">
                Enter your assigned <strong>Team Number</strong>, enable motion sensors, and
                calibrate your paddle.
              </p>
              {snapshot.admissionLocked && (
                <span className="pill pill-paused">Admission Locked (Rejoining Open)</span>
              )}
            </div>

            <div
              className="dynamic-team-grid"
              data-count={snapshot.teams.length}
              style={gridVars}
            >
              {snapshot.teams.map((team, cardIndex) => {
                const belowMin = team.limbCount < team.minSeats;
                const atMax = team.limbCount >= team.maxSeats;
                return (
                  <article
                    key={team.teamNumber}
                    className="team-training-card"
                    style={{ '--i': cardIndex } as React.CSSProperties}
                  >
                    <div className="team-card-header">
                      <div className="team-card-num">
                        <span
                          className="team-swatch-dot"
                          style={{ backgroundColor: team.colorHex }}
                        />
                        Team {team.teamNumber} · {team.teamName}
                      </div>
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
                    </div>

                    <CreatureCardCanvas
                      team={team}
                      effects={effectsRef.current}
                      isPaused={false}
                    />

                    <div className="limb-status-row">
                      {team.limbs.map((l) => (
                        <div
                          key={l.limbIndex}
                          className={`limb-chip ${l.calibrated ? 'is-calibrated' : ''}`}
                        >
                          L{l.limbIndex + 1}{' '}
                          {l.calibrated ? 'Cal ✓' : l.connected ? 'Joined' : 'Offline'}
                        </div>
                      ))}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        ))}

      {/* 2. TRAINING GRID VIEW: Dynamic joined-team grid with proportional card resizing */}
      {snapshot.phase === 'training' && (
        <section
          style={{
            position: 'relative',
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {snapshot.teams.length === 0 ? (
            <div className="lobby-empty-stage">
              <div className="overlay-box">
                <h2 className="comic-word">Waiting for Teams!</h2>
                <p>
                  Click <strong>Join QR</strong> in the top bar so participants can scan{' '}
                  <code>{playUrl}</code> and spawn their team creatures.
                </p>
              </div>
            </div>
          ) : (
            <div
              className="dynamic-team-grid"
              data-count={snapshot.teams.length}
              style={gridVars}
            >
              {snapshot.teams.map((team, cardIndex) => {
                const ackAgeMs = team.latestAcknowledgment
                  ? snapshot.serverNowMs - team.latestAcknowledgment.atServerMs
                  : null;
                const isAckFresh = ackAgeMs !== null && ackAgeMs < 2400;
                const belowMin = team.limbCount < team.minSeats;

                return (
                  <article
                    key={team.teamNumber}
                    className="team-training-card"
                    style={{ '--i': cardIndex } as React.CSSProperties}
                  >
                    <div className="team-card-header">
                      <div className="team-card-num">
                        <span
                          className="team-swatch-dot"
                          style={{ backgroundColor: team.colorHex }}
                        />
                        Team {team.teamNumber} · {team.teamName}
                      </div>
                      <span className={`pill ${belowMin ? 'pill-paused' : ''}`}>
                        {team.practicedCount}/{team.limbCount} practiced · {team.calibratedCount}/
                        {team.limbCount} cal
                        {belowMin ? ` (min ${team.minSeats})` : ''}
                      </span>
                    </div>

                    <CreatureCardCanvas
                      team={team}
                      effects={effectsRef.current}
                      isPaused={snapshot.runStatus !== 'running'}
                    />

                    <div className="limb-status-row">
                      {team.limbs.map((l) => (
                        <div
                          key={l.limbIndex}
                          className={`limb-chip ${
                            l.hasSucceededStroke
                              ? 'is-succeeded'
                              : l.calibrated && l.connected
                                ? 'is-calibrated'
                                : ''
                          }`}
                        >
                          L{l.limbIndex + 1}{' '}
                          {l.hasSucceededStroke
                            ? '✓'
                            : l.calibrated
                              ? l.connected
                                ? 'Cal'
                                : 'Off'
                              : 'Setup'}
                        </div>
                      ))}
                    </div>

                    <div className={`card-ack-bar ${isAckFresh ? 'is-fresh' : ''}`}>
                      <span>
                        {team.latestAcknowledgment
                          ? team.latestAcknowledgment.text
                          : snapshot.runStatus === 'ready'
                            ? 'Waiting for facilitator to start training'
                            : 'Hold button & sweep your assigned direction'}
                      </span>
                    </div>
                  </article>
                );
              })}
            </div>
          )}

          {snapshot.runStatus === 'paused' && (
            <div className="stage-overlay">
              <div className="overlay-box">
                <h2 className="comic-word">
                  {snapshot.round.pausedForDiscussion ? 'Time to Talk!' : 'Paused!'}
                </h2>
                {snapshot.round.pausedForDiscussion ? (
                  <ul>
                    <li>How did visual and limb feedback help you learn your unfamiliar paddle mapping?</li>
                    <li>How does learning your own limb differ from coordinating with 4 to 5 teammates?</li>
                    <li>What strategy will your team use when the race begins?</li>
                  </ul>
                ) : (
                  <p>Paddles are frozen. Wait for the facilitator to resume or load the race.</p>
                )}
              </div>
            </div>
          )}
        </section>
      )}

      {/* 3. STRAIGHT RACE & FREE-WATER ARENA VIEWS */}
      {(snapshot.phase === 'straight' || snapshot.phase === 'freewater') && (
        <section className="arena-stage-wrap">
          <canvas
            ref={arenaCanvasRef}
            width={snapshot.round.arenaWidth}
            height={snapshot.round.arenaHeight}
            className="arena-canvas"
          />

          {/* Staged Ready Overlay */}
          {snapshot.runStatus === 'ready' && (
            <div className="stage-overlay">
              <div className="overlay-box">
                <span className="overlay-sticker" aria-hidden="true">
                  <ComicBurst fill="#ff5aa5" seed={7} className="burst-wobble">
                    <span className="comic-word" style={{ '--word-fill': '#ffffff' } as React.CSSProperties}>
                      READY?
                    </span>
                  </ComicBurst>
                </span>
                <h2 className="comic-word">{phaseTitle}</h2>
                <p>
                  {snapshot.phase === 'straight'
                    ? 'Every team member keeps the same limb and gesture. Paddle together to reach the checkered finish line first!'
                    : snapshot.round.scoringEnabled
                      ? 'Left-bank paddles turn right; right-bank paddles turn left. Collect golden bugs & glowing seeds!'
                      : 'Unscored steering familiarization: practice turning your shared creature in open water.'}
                </p>
              </div>
            </div>
          )}

          {/* Shared 3-2-1 Countdown Overlay */}
          {snapshot.runStatus === 'countdown' && (
            <div className="stage-overlay">
              <div className="overlay-box overlay-box-clear">
                <div className="caption-box overlay-kicker">Starting Together In</div>
                <div>
                  <ComicBurst fill="#dc1f26" spikes={15} seed={3} className="countdown-burst">
                    <span key={countdownDigit} className="countdown-digits comic-word">
                      {countdownDigit}
                    </span>
                  </ComicBurst>
                </div>
              </div>
            </div>
          )}

          {/* Pause / Discussion Overlay */}
          {snapshot.runStatus === 'paused' && (
            <div className="stage-overlay">
              <div className="overlay-box">
                <h2 className="comic-word">
                  {snapshot.round.pausedForDiscussion ? 'Time to Talk!' : 'Paused!'}
                </h2>
                <p>
                  Simulation, positions, and remaining active clock ({formatClock(snapshot.round.remainingMs)}) are preserved.
                  Release and press again once resumed.
                </p>
              </div>
            </div>
          )}

          {/* Authoritative Results Overlay */}
          {snapshot.runStatus === 'finished' && (
            <div className="stage-overlay">
              <div className="overlay-box">
                <span className="overlay-sticker" aria-hidden="true">
                  <ComicBurst fill="#ffd91a" seed={9} className="burst-pop">
                    <span className="comic-word" style={{ '--word-fill': '#dc1f26' } as React.CSSProperties}>
                      {snapshot.phase === 'straight' ? 'FINISH!' : 'YUM!'}
                    </span>
                  </ComicBurst>
                </span>
                <h2 className="comic-word">
                  {snapshot.phase === 'straight'
                    ? 'Straight Race Results'
                    : snapshot.round.scoringEnabled
                      ? 'Pond Harvest Results'
                      : 'Steering Practice Complete'}
                </h2>

                {(snapshot.phase === 'straight' || snapshot.round.scoringEnabled) && (
                  <table className="results-table">
                    <thead>
                      <tr>
                        <th>Rank</th>
                        <th>Team</th>
                        <th>{snapshot.phase === 'straight' ? 'Finish / Distance' : 'Items Collected'}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedResults.map((team, rowIndex) => {
                        const pct = Math.round(
                          (team.sim.laneProgress / snapshot.round.courseLength) * 100,
                        );
                        return (
                          <tr
                            key={team.teamNumber}
                            className={team.sim.rank === 1 ? 'is-winner' : undefined}
                            style={{ '--i': rowIndex } as React.CSSProperties}
                          >
                            <td>
                              <strong>#{team.sim.rank ?? '—'}</strong>
                            </td>
                            <td>
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.45rem' }}>
                                <span
                                  className="team-swatch-dot"
                                  style={{ backgroundColor: team.colorHex }}
                                />
                                <strong>Team {team.teamNumber}</strong> · {team.teamName}
                              </span>
                            </td>
                            <td>
                              {snapshot.phase === 'straight'
                                ? team.sim.finished && team.sim.finishTimeMs !== null
                                  ? `Finished in ${(team.sim.finishTimeMs / 1000).toFixed(2)}s`
                                  : `Did Not Finish (${pct}% of course)`
                                : `${team.sim.score} point${team.sim.score === 1 ? '' : 's'}`}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}
        </section>
      )}
    </main>
  );
};
