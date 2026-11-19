import React, { useEffect, useRef, useState } from 'react';
import type {
  DiscussionTopic,
  GameTeamResult,
  ItemCollectedBroadcast,
  SessionPublicSnapshot,
  StrokeAcceptedBroadcast,
  TeamPublicState,
} from '../../shared/types.js';
import {
  GESTURE_ASSIGNMENT_ORDER,
  GUIDE_STEPS,
  MUSIC_VOLUME_DEFAULT,
  POND_ITEMS,
  PROJECT_REPO_URL,
  POND_ITEM_ORDER,
  SECTION_LABELS,
  formatSectionClock,
} from '../../shared/constants.js';
import { ComicBurst } from '../components/ComicBurst.js';
import { CreatureCardCanvas } from '../components/CreatureCardCanvas.js';
import { GestureDemoBadge } from '../components/GestureDemoBadge.js';
import { SweepSteps } from '../components/SweepSteps.js';
import { FeedbackController } from '../feedback.js';
import { PartyMusic, type MusicMood } from '../music.js';
import {
  drawFreewaterScene,
  drawStraightRaceScene,
  type TransientVisualEffects,
} from '../pondRenderer.js';
import { createPondSocket } from '../socketClient.js';

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
 * Discussion copy. Draft wording: the project owner set the direction (spec Section 5.4) but has not
 * signed off the exact sentences (spec Section 16).
 * The first set deliberately does not give away the synchrony rule the class is meant to discover.
 * The second ties the experience back to the reading, Won et al. (2015), "Homuncular Flexibility in
 * Virtual Reality": learning an unfamiliar body mapping, moving differently once the mapping rewards
 * it, and one person with a novel body versus a team sharing one.
 */
const DISCUSSION_PROMPTS: Record<
  DiscussionTopic,
  { kicker: string; title: string; questions: string[] }
> = {
  before_game1: {
    kicker: 'Before Game 1',
    title: 'What Makes You Fast?',
    questions: [
      'Have you figured out what makes your creature surge ahead, and what makes it crawl?',
      'What will your team do differently in the race?',
    ],
  },
  after_game1: {
    kicker: 'After Game 1',
    title: 'A Body That Isn’t Yours',
    questions: [
      'Your phone sweep became a paddle stroke. When did that odd mapping start to feel like your own limb?',
      'In the paper, people moved differently once a remapped body rewarded it. How did your sweeps change once you knew what made you fast?',
      'The paper gives one person a new body. You shared one with a team. What did sharing change?',
    ],
  },
};

/** Points with thousands separators: 1300 -> "1,300" */
function formatPoints(points: number): string {
  return points.toLocaleString('en-US');
}

function formatSyncPct(syncAvg: number | null): string {
  return syncAvg === null ? '—' : `${Math.round(syncAvg * 100)}%`;
}

/** Best (highest) value among the results that have one, with every team that shares it. */
function pickHighlight(
  results: GameTeamResult[],
  valueOf: (r: GameTeamResult) => number | null,
  format: (best: number) => string,
): { value: string; teams: string } | null {
  let best: number | null = null;
  let holders: number[] = [];
  for (const r of results) {
    const v = valueOf(r);
    if (v === null) continue;
    if (best === null || v > best) {
      best = v;
      holders = [r.teamNumber];
    } else if (v === best) {
      holders.push(r.teamNumber);
    }
  }
  if (best === null) return null;
  return {
    value: format(best),
    teams: holders.length === 1 ? `Team ${holders[0]}` : `Teams ${holders.join(' & ')}`,
  };
}

function formatRaceOutcome(result: GameTeamResult): string {
  return result.finished && result.finishTimeMs !== null
    ? `${(result.finishTimeMs / 1000).toFixed(1)}s`
    : `${result.progressPct}% of course`;
}

const JoinQrPanel: React.FC<{
  qrSrc: string;
  playUrl: string;
  sizeRangeText: string;
  admissionLocked: boolean;
  hero?: boolean;
  children: React.ReactNode;
}> = ({ qrSrc, playUrl, sizeRangeText, admissionLocked, hero = false, children }) => (
  <div className={`qr-panel ${hero ? 'qr-panel-hero' : ''}`}>
    <h2 className="comic-word">Scan to Join!</h2>
    <div className="qr-image-frame">
      <img src={qrSrc} alt={`Join QR code for ${playUrl}`} />
    </div>
    <div className="join-url-pill">{playUrl}</div>
    <span className="pill pill-ready">{sizeRangeText}</span>
    <p className="speech-bubble">{children}</p>
    {admissionLocked && <span className="pill pill-paused">Admission Locked (Rejoining Open)</span>}
  </div>
);

/**
 * Training-phase panel beside the team cards. Teams have already joined by now, so instead of the
 * join code it teaches the one thing everyone has to get right, Press / Move / Release, and
 * reminds players to lock rotation (an unlocked screen can flip sideways mid-sweep).
 */
const TrainingHelpPanel: React.FC = () => (
  <div className="qr-panel training-help-panel">
    <h2 className="comic-word">Every Stroke</h2>
    <SweepSteps layout="display" />
    <div className="rotation-reminder">
      <svg className="rotation-icon" viewBox="0 0 120 120" aria-hidden="true">
        {/* Upright phone */}
        <rect x="38" y="14" width="44" height="80" rx="8" fill="#ffffff" stroke="#14121f" strokeWidth="5" />
        <line x1="52" y1="24" x2="68" y2="24" stroke="#14121f" strokeWidth="4" strokeLinecap="round" />
        {/* Padlock on the screen */}
        <path d="M51 56 v-7 a9 9 0 0 1 18 0 v7" fill="none" stroke="#14121f" strokeWidth="5" strokeLinecap="round" />
        <rect x="46" y="55" width="28" height="23" rx="4" fill="#ffd91a" stroke="#14121f" strokeWidth="5" />
        {/* Crossed-out turn arrow */}
        <path d="M92 96 a44 44 0 0 1 -64 0" fill="none" stroke="#14121f" strokeWidth="5" strokeLinecap="round" />
        <path d="M22 86 l5 12 l12 -5" fill="none" stroke="#14121f" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
        <line x1="48" y1="100" x2="72" y2="116" stroke="#dc1f26" strokeWidth="6" strokeLinecap="round" />
      </svg>
      <div className="rotation-reminder-text">
        <strong>Lock rotation!</strong>
        <span>
          iPhone: swipe down from the top-right corner, tap the <b>rotation lock</b>.
        </span>
        <span>
          Android: swipe down from the top, switch <b>Auto-rotate</b> off.
        </span>
      </div>
    </div>
  </div>
);

/**
 * Read-only Classroom Projector Display (/screen, Section 5).
 * Strictly exposes zero administrative actions, reset buttons, or credentials.
 */
export const ScreenView: React.FC = () => {
  const [snapshot, setSnapshot] = useState<SessionPublicSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [showQrDrawer, setShowQrDrawer] = useState(false);
  const [showRotationTip, setShowRotationTip] = useState(true);
  const [muted, setMuted] = useState(false);
  const [musicBlocked, setMusicBlocked] = useState(false);
  // Latest points gained per team, for the "+300" chip that pops beside its score
  const [scoreGains, setScoreGains] = useState<Record<number, { points: number; key: string }>>({});
  const musicRef = useRef<PartyMusic | null>(null);
  /** When a click last had to start held-back music; that click must not also toggle Sound off */
  const gestureStartedMusicAtMsRef = useRef(Number.NEGATIVE_INFINITY);

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
        variant: ev.variant,
        points: ev.points,
        teamNumber: ev.teamNumber,
      });
      setScoreGains((prev) => ({ ...prev, [ev.teamNumber]: { points: ev.points, key: awardKey } }));
      // The rarer the item, the bigger the sound
      feedbackRef.current.playTone(
        ev.variant === 'pond_star'
          ? 'collected_jackpot'
          : ev.variant === 'golden_bug'
            ? 'collected_big'
            : 'collected',
      );
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
            // Game 1 Prep laps jump back to the start line; snap instead of sliding backward
            const lapWrapped = prev !== undefined && t.sim.laneProgress < prev.laneProgress - 50;
            if (!prev || reducedMotion || curSnap.runStatus !== 'running' || lapWrapped) {
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

  // Background music: the facilitator's switch (Mission Control) decides whether there is any; the
  // phase decides which track. Discussions are silent so the room can talk.
  const musicMood: MusicMood = ((): MusicMood => {
    if (!snapshot?.musicEnabled || snapshot.phase === 'discussion') return 'silent';
    if (snapshot.phase === 'leaderboard') return 'results';
    const live = snapshot.runStatus === 'countdown' || snapshot.runStatus === 'running';
    if (!live || snapshot.guideVisible) return 'lobby';
    if (snapshot.phase === 'training') return 'practice';
    if (snapshot.phase === 'straight' || snapshot.phase === 'freewater') {
      return snapshot.round.scoringEnabled ? 'game' : 'practice';
    }
    return 'lobby';
  })();
  const musicVolume = snapshot?.musicVolume ?? MUSIC_VOLUME_DEFAULT;
  /** The display's one music player, created on first need and wired to report when audio is held back. */
  const getMusic = (): PartyMusic => {
    if (!musicRef.current) {
      const music = new PartyMusic();
      music.onBlockedChange = (blocked) => setMusicBlocked(blocked);
      musicRef.current = music;
    }
    return musicRef.current;
  };
  useEffect(() => {
    if (musicMood === 'silent' && !musicRef.current) return;
    const music = getMusic();
    music.setVolume(musicVolume);
    music.setMood(musicMood);
    // Development builds only: lets an automated check read the output level
    if (snapRef.current?.devSimAvailable) {
      (window as unknown as { __pondMusic?: PartyMusic }).__pondMusic = music;
    }
    // Browsers hold audio back until the page is clicked; say so on screen rather than stay silent
    const check = window.setTimeout(() => setMusicBlocked(music.needsUnlock()), 500);
    return () => window.clearTimeout(check);
  }, [musicMood]);
  // The facilitator's volume slider (Mission Control) follows live, without restarting anything
  useEffect(() => {
    musicRef.current?.setVolume(musicVolume);
  }, [musicVolume]);
  useEffect(() => {
    // Every click or key press on the display opens the audio device, even before music is switched
    // on: a browser only allows that inside a user gesture, so the earliest one is used.
    const unlock = () => {
      const music = getMusic();
      if (music.needsUnlock()) gestureStartedMusicAtMsRef.current = performance.now();
      music.prime();
      window.setTimeout(() => setMusicBlocked(music.needsUnlock()), 300);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
      musicRef.current?.dispose();
      musicRef.current = null;
    };
  }, []);

  // A new round starts with no "+points" chips left over from the last one
  const scoreRoundId = snapshot?.round.roundId ?? null;
  useEffect(() => {
    setScoreGains({});
  }, [scoreRoundId]);

  // Every time Training is loaded the how-to panel comes back beside the grid
  const trainingRoundId = snapshot?.phase === 'training' ? snapshot.round.roundId : null;
  useEffect(() => {
    if (trainingRoundId) setShowRotationTip(true);
  }, [trainingRoundId]);

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

  const scored = snapshot.round.scoringEnabled;
  const discussion =
    snapshot.phase === 'discussion'
      ? DISCUSSION_PROMPTS[snapshot.round.discussionTopic ?? 'after_game1']
      : null;
  // Discussion and leaderboard are display-only: no run status, network mode, or round to report
  const isDisplayOnlyPhase = snapshot.phase === 'discussion' || snapshot.phase === 'leaderboard';

  const phaseTitle =
    snapshot.phase === 'lobby'
      ? 'Lobby · Join Your Team'
      : snapshot.phase === 'training'
        ? 'Team Paddle Training'
        : snapshot.phase === 'straight'
          ? scored
            ? 'Game 1 · Straight Pond Race'
            : 'Game 1 Prep · Straight Swim Practice'
          : snapshot.phase === 'freewater'
            ? scored
              ? 'Game 2 · Free-Water Pond Harvest'
              : 'Game 2 Prep · Free-Water Steering Practice'
            : snapshot.phase === 'discussion'
              ? `Discussion · ${discussion?.kicker ?? ''}`
              : 'Leaderboard · Session Results';

  // Guide reveal: a panel is hidden until the facilitator reaches its step, and the newest one is marked
  const guideStep = Math.max(1, Math.min(GUIDE_STEPS.length, snapshot.guideStep ?? GUIDE_STEPS.length));
  const guidePanelClass = (name: string, revealedAt: number, newestAt: number): string =>
    `guide-panel ${name} ${guideStep >= revealedAt ? 'is-revealed' : 'is-waiting'} ${
      guideStep === newestAt && guideStep > 1 ? 'is-newest' : ''
    }`;

  const lobbyCountText =
    snapshot.phase === 'lobby'
      ? `${snapshot.teams.reduce((s, t) => s + t.joinedCount, 0)} Seated · ${snapshot.teams.length} ${
          snapshot.teams.length === 1 ? 'Team' : 'Teams'
        }`
      : null;

  // Section clock: counts down from the section's planned time, then turns red and runs negative.
  // The server ends Game 1 and Game 2 at zero; every other section is only paced by it.
  const sectionClock = snapshot.sectionClock;
  const sectionOver = sectionClock.section !== null && sectionClock.remainingMs <= 0;
  // One badge, used in the header and again on top of the guide, which covers the header
  const sectionClockBadge =
    sectionClock.section !== null ? (
      <div
        className={`screen-clock section-clock ${sectionOver ? 'is-over' : ''} ${
          sectionClock.running ? '' : 'is-waiting'
        }`}
        role="timer"
        aria-label={`${SECTION_LABELS[sectionClock.section]}: ${
          sectionOver ? 'over time by' : 'time left'
        } ${formatSectionClock(sectionClock.remainingMs).replace('-', '')}`}
      >
        {sectionOver && <span className="section-clock-flag">Over</span>}
        {formatSectionClock(sectionClock.remainingMs)}
      </div>
    ) : null;

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

  const { leaderboard } = snapshot;
  const teamByNumber = new Map(snapshot.teams.map((t) => [t.teamNumber, t]));
  const raceResultByTeam = new Map(
    (leaderboard.straight?.teams ?? []).map((r) => [r.teamNumber, r]),
  );
  const harvestResultByTeam = new Map(
    (leaderboard.freewater?.teams ?? []).map((r) => [r.teamNumber, r]),
  );
  // The frozen result of the round on screen (sync figures for the Game 1 results table)
  const thisRaceResult =
    leaderboard.straight?.roundId === snapshot.round.roundId ? raceResultByTeam : null;

  // Session highlights for the leaderboard. Each names every team sharing the best value and is
  // omitted until a game has produced one.
  const raceTeams = leaderboard.straight?.teams ?? [];
  const fastestFinish = pickHighlight(
    raceTeams,
    (r) => (r.finished && r.finishTimeMs !== null ? -r.finishTimeMs : null),
    (best) => `${(-best / 1000).toFixed(1)}s`,
  );
  const bestSync = pickHighlight(
    raceTeams,
    (r) => (r.syncAvg !== null ? Math.round(r.syncAvg * 100) : null),
    (best) => `${best}%`,
  );
  const topHarvest = pickHighlight(
    leaderboard.freewater?.teams ?? [],
    (r) => (r.score > 0 ? r.score : null),
    (best) => formatPoints(best),
  );
  const sessionStrokes = [...raceResultByTeam.values(), ...harvestResultByTeam.values()].reduce(
    (sum, r) => sum + r.strokes,
    0,
  );

  return (
    <main className="screen-shell">
      {/* Compact Public Header (No admin controls!) */}
      <header className="screen-header">
        <div className="screen-title-group">
          <h1 className="screen-title">{phaseTitle}</h1>
          {!isDisplayOnlyPhase && (
            <>
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
            </>
          )}
        </div>

        <div className="screen-title-group">
          {lobbyCountText !== null && <div className="screen-clock">{lobbyCountText}</div>}

          {sectionClockBadge}

          {snapshot.phase === 'training' && snapshot.teams.length > 0 && !snapshot.guideVisible && (
            <button
              type="button"
              className="btn-subtle btn-xs"
              onClick={() => setShowRotationTip((v) => !v)}
            >
              {showRotationTip ? 'Hide How-To' : 'Show How-To'}
            </button>
          )}

          {/* Latecomers: the join QR is a corner drawer outside the lobby (Training included) */}
          {snapshot.phase !== 'lobby' &&
            !(snapshot.phase === 'training' && snapshot.teams.length === 0) &&
            !snapshot.admissionLocked &&
            !snapshot.guideVisible && (
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
              // If this very click is what let the browser start the music, it has done its job
              if (!muted && performance.now() - gestureStartedMusicAtMsRef.current < 800) return;
              const next = !muted;
              setMuted(next);
              feedbackRef.current.setMuted(next);
              musicRef.current?.setMuted(next);
            }}
          >
            {muted ? 'Sound Off' : 'Sound On'}
          </button>

          {!connected && <span className="pill pill-danger">Reconnecting</span>}
        </div>
      </header>

      {/* Expandable corner QR drawer for latecomers (the lobby carries the join panel on the left) */}
      {showQrDrawer &&
        snapshot.phase !== 'lobby' &&
        !(snapshot.phase === 'training' && snapshot.teams.length === 0) &&
        !snapshot.admissionLocked &&
        !snapshot.guideVisible && (
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
            <JoinQrPanel
              qrSrc={qrSrc}
              playUrl={playUrl}
              sizeRangeText={sizeRangeText}
              admissionLocked={snapshot.admissionLocked}
            >
              Enter your assigned <strong>Team Number</strong>, enable motion sensors, and calibrate
              your paddle.
            </JoinQrPanel>

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
                          {l.playerEmoji && <span className="limb-chip-emoji">{l.playerEmoji}</span>}
                          <span className="limb-chip-name">{l.playerName ?? `L${l.limbIndex + 1}`}</span>{' '}
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

      {/* 2. TRAINING GRID VIEW: Press/Move/Release how-to on the left, live team-card grid beside it */}
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
              <JoinQrPanel
                qrSrc={qrSrc}
                playUrl={playUrl}
                sizeRangeText={sizeRangeText}
                admissionLocked={snapshot.admissionLocked}
                hero
              >
                Waiting for teams! Scan, enter your <strong>Team Number</strong>, and your creature
                appears here.
              </JoinQrPanel>
            </div>
          ) : (
            <div className={showRotationTip ? 'lobby-layout' : 'training-grid-only'}>
              {showRotationTip && <TrainingHelpPanel />}
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
                            {l.playerEmoji && <span className="limb-chip-emoji">{l.playerEmoji}</span>}
                            <span className="limb-chip-name">{l.playerName ?? `L${l.limbIndex + 1}`}</span>{' '}
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
                              : 'Press, move along your arrow, release'}
                        </span>
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          )}

          {snapshot.runStatus === 'paused' && (
            <div className="stage-overlay">
              <div className="overlay-box">
                <h2 className="comic-word">Paused!</h2>
                <p>Paddles are frozen. Wait for the facilitator to resume.</p>
              </div>
            </div>
          )}
        </section>
      )}

      {/* 3. STRAIGHT SWIM & FREE-WATER ARENA VIEWS (prep rounds are the same arenas, unscored) */}
      {(snapshot.phase === 'straight' || snapshot.phase === 'freewater') && (
        <section className="arena-stage-wrap">
          {/* Game 2 and its prep: big live scoreboard beside the water, leader on top */}
          {snapshot.phase === 'freewater' && (
            <aside
              className="scoreboard"
              aria-label={scored ? 'Live scores' : 'Practice scores'}
              style={{ '--n': Math.max(1, competingTeams.length) } as React.CSSProperties}
            >
              <div className="scoreboard-title comic-word">{scored ? 'Score' : 'Practice'}</div>
              <ol className="scoreboard-list">
                {[...competingTeams]
                  .sort((a, b) => b.sim.score - a.sim.score || a.teamNumber - b.teamNumber)
                  .map((team, place) => {
                    const gain = scoreGains[team.teamNumber];
                    const leading = place === 0 && team.sim.score > 0;
                    return (
                      <li
                        key={team.teamNumber}
                        className={`score-tile ${leading ? 'is-leading' : ''}`}
                        style={{ '--team': team.colorHex } as React.CSSProperties}
                      >
                        <div className="score-tile-head">
                          <span className="score-tile-place">{place + 1}</span>
                          <span className="team-swatch-dot" style={{ backgroundColor: team.colorHex }} />
                          <span className="score-tile-team">Team {team.teamNumber}</span>
                        </div>
                        <div className="score-tile-points">
                          <span key={team.sim.score} className="score-tile-number">
                            {formatPoints(team.sim.score)}
                          </span>
                          {gain && (
                            <span key={gain.key} className="score-gain" aria-hidden="true">
                              +{formatPoints(gain.points)}
                            </span>
                          )}
                        </div>
                      </li>
                    );
                  })}
              </ol>
              <div className="scoreboard-legend">
                {POND_ITEM_ORDER.map((variant) => (
                  <span key={variant} className={`legend-item legend-${variant}`}>
                    {POND_ITEMS[variant].label} <strong>{formatPoints(POND_ITEMS[variant].points)}</strong>
                  </span>
                ))}
              </div>
            </aside>
          )}
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
                    ? scored
                      ? 'Same limb, same sweep. The race runs until the last creature crosses the checkered line or the clock hits zero!'
                      : 'Practice lap after lap, no score. Experiment as a team: what makes your creature surge ahead?'
                    : scored
                      ? `Left-bank paddles turn right; right-bank paddles turn left. Seeds ${POND_ITEMS.glow_seed.points}, golden bugs ${POND_ITEMS.golden_bug.points}, and the rare star ${formatPoints(POND_ITEMS.pond_star.points)}. The harvest ends when the clock hits zero!`
                      : 'Steering practice with real items to chase. Points here are just for practice and are not kept.'}
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

          {/* Pause Overlay */}
          {snapshot.runStatus === 'paused' && (
            <div className="stage-overlay">
              <div className="overlay-box">
                <h2 className="comic-word">Paused!</h2>
                <p>
                  Positions and scores are kept exactly as they are.
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
                      {!scored ? 'NICE!' : snapshot.phase === 'straight' ? 'FINISH!' : 'YUM!'}
                    </span>
                  </ComicBurst>
                </span>
                <h2 className="comic-word">
                  {!scored
                    ? 'Practice Complete'
                    : snapshot.phase === 'straight'
                      ? 'Straight Race Results'
                      : 'Pond Harvest Results'}
                </h2>

                {!scored && <p>No score this round. Eyes up front for what comes next.</p>}

                {scored && (
                  <table className="results-table">
                    <thead>
                      <tr>
                        <th>Rank</th>
                        <th>Team</th>
                        <th>{snapshot.phase === 'straight' ? 'Finish / Distance' : 'Points'}</th>
                        {snapshot.phase === 'straight' && thisRaceResult && <th>In Sync</th>}
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
                                : `${formatPoints(team.sim.score)} points · ${team.sim.itemsCollected} item${team.sim.itemsCollected === 1 ? '' : 's'}`}
                            </td>
                            {snapshot.phase === 'straight' && thisRaceResult && (
                              <td>{formatSyncPct(thisRaceResult.get(team.teamNumber)?.syncAvg ?? null)}</td>
                            )}
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

      {/* 4. DISCUSSION: a dedicated phase with its own prompts; nothing is simulated behind it */}
      {discussion && (
        <section className="talk-stage">
          <div className="talk-panel">
            <span className="talk-sticker" aria-hidden="true">
              <ComicBurst fill="#ff5aa5" seed={5} className="burst-wobble">
                <span className="comic-word" style={{ '--word-fill': '#ffffff' } as React.CSSProperties}>
                  TALK!
                </span>
              </ComicBurst>
            </span>
            <div className="caption-box talk-kicker">{discussion.kicker}</div>
            <h2 className="comic-word">{discussion.title}</h2>
            <ol className="talk-questions">
              {discussion.questions.map((q) => (
                <li key={q}>{q}</li>
              ))}
            </ol>
            {snapshot.round.discussionTopic === 'after_game1' && leaderboard.straight && (
              <div className="talk-recap">
                <span className="talk-recap-label">Game 1</span>
                {[...leaderboard.straight.teams]
                  .sort((x, y) => (x.rank ?? 99) - (y.rank ?? 99) || x.teamNumber - y.teamNumber)
                  .map((r) => (
                    <span key={r.teamNumber} className="pill">
                      <span
                        className="team-swatch-dot"
                        style={{
                          backgroundColor: teamByNumber.get(r.teamNumber)?.colorHex,
                          width: 10,
                          height: 10,
                        }}
                      />
                      #{r.rank ?? '—'} Team {r.teamNumber} · {formatRaceOutcome(r)} ·{' '}
                      {formatSyncPct(r.syncAvg)} in sync
                    </span>
                  ))}
              </div>
            )}
          </div>
        </section>
      )}

      {/* 5. LEADERBOARD: frozen results of the last completed run of each scored game */}
      {snapshot.phase === 'leaderboard' && (
        <section className="leaderboard-stage">
          {/* Where the class can find the code: this project's public repository */}
          <aside className="repo-card" aria-label="Source code">
            <h2 className="repo-card-title">Open Source!</h2>
            <div className="qr-image-frame repo-card-qr">
              <img
                src={`/api/qr?url=${encodeURIComponent(PROJECT_REPO_URL)}`}
                alt={`QR code for the source code at ${PROJECT_REPO_URL}`}
              />
            </div>
            <p className="repo-card-lead">Scan for the code behind this game</p>
            <p className="repo-card-url">{PROJECT_REPO_URL.replace(/^https?:\/\//, '')}</p>
          </aside>
          <div className="leaderboard-panel">
            <h2 className="comic-word">Final Standings</h2>

            {leaderboard.standings.length === 0 ? (
              <p className="leaderboard-empty">
                No scored game has finished yet. Standings appear here after Game 1 or Game 2.
              </p>
            ) : (
              <>
                <div className="stat-tile-row">
                  {(
                    [
                      ['Fastest Finish', fastestFinish],
                      ['Best Team Sync', bestSync],
                      ['Biggest Harvest', topHarvest],
                    ] as const
                  ).map(
                    ([label, highlight]) =>
                      highlight && (
                        <div key={label} className="stat-tile">
                          <span className="stat-tile-label">{label}</span>
                          <span className="stat-tile-value">{highlight.value}</span>
                          <span className="stat-tile-team">{highlight.teams}</span>
                        </div>
                      ),
                  )}
                  <div className="stat-tile">
                    <span className="stat-tile-label">Strokes Landed</span>
                    <span className="stat-tile-value">{sessionStrokes}</span>
                    <span className="stat-tile-team">Whole class</span>
                  </div>
                </div>

                <table className="results-table leaderboard-table">
                  <thead>
                    <tr>
                      <th>Rank</th>
                      <th>Team</th>
                      <th>Game 1 · Race</th>
                      <th>In Sync</th>
                      <th>Game 2 · Harvest</th>
                      <th>Strokes</th>
                      <th>Points</th>
                    </tr>
                  </thead>
                  <tbody>
                    {leaderboard.standings.map((row, rowIndex) => {
                      const team = teamByNumber.get(row.teamNumber);
                      const race = raceResultByTeam.get(row.teamNumber);
                      const harvest = harvestResultByTeam.get(row.teamNumber);
                      return (
                        <tr
                          key={row.teamNumber}
                          className={row.rank === 1 ? 'is-winner' : undefined}
                          style={{ '--i': rowIndex } as React.CSSProperties}
                        >
                          <td>
                            <strong>#{row.rank}</strong>
                          </td>
                          <td>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.45rem' }}>
                              <span
                                className="team-swatch-dot"
                                style={{ backgroundColor: team?.colorHex }}
                              />
                              <strong>Team {row.teamNumber}</strong>
                              {team ? ` · ${team.teamName}` : ''}
                            </span>
                          </td>
                          <td>{race ? `#${race.rank ?? '—'} · ${formatRaceOutcome(race)}` : '—'}</td>
                          <td>
                            {race ? formatSyncPct(race.syncAvg) : '—'}
                            {race && race.fullSyncCount ? (
                              <span className="leaderboard-sub"> · {race.fullSyncCount}× all together</span>
                            ) : null}
                          </td>
                          <td>
                            {harvest
                              ? `#${harvest.rank ?? '—'} · ${formatPoints(harvest.score)} pts`
                              : '—'}
                          </td>
                          <td>{(race?.strokes ?? 0) + (harvest?.strokes ?? 0)}</td>
                          <td>
                            <strong>{row.points}</strong>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>

                <p className="leaderboard-note">
                  Points per game: teams in the game minus your rank, plus 1. Ties share a rank.{' '}
                  {!leaderboard.straight
                    ? 'Game 1 has not been played.'
                    : !leaderboard.freewater
                      ? 'Game 2 has not been played.'
                      : ''}
                </p>
              </>
            )}
          </div>
        </section>
      )}

      {/* 6. HOW-TO-PLAY GUIDE: shown by default on a fresh session, toggled from Mission Control; read-only here */}
      {snapshot.guideVisible && (
        <section className="guide-stage" aria-label="How to play">
          {/* The guide covers the header, so it carries its own title and the section clock, top right */}
          <div className="guide-bar">
            <h1 className="guide-bar-title">How to Play</h1>
            {sectionClockBadge}
          </div>
          {/* Revealed one step at a time from Mission Control: the game idea, steps 1 to 3, then the QR code */}
          <div className={`guide-grid ${guideStep <= 1 ? 'guide-grid-intro' : ''}`}>
            <article className={guidePanelClass('guide-join', 2, guideStep >= 5 ? 5 : 2)} aria-hidden={guideStep < 2}>
              <h2 className="guide-heading">
                <span className="guide-num">1</span> Scan &amp; Join
              </h2>
              {guideStep >= 5 ? (
                <>
                  <div className="qr-image-frame guide-qr-live">
                    <img src={qrSrc} alt={`Join QR code for ${playUrl}`} />
                  </div>
                  <div className="join-url-pill">{playUrl}</div>
                </>
              ) : (
                <div className="qr-image-frame guide-qr-waiting">
                  <span className="guide-qr-waiting-mark" aria-hidden="true">
                    ?
                  </span>
                  <span>The QR code appears here when it is time to join.</span>
                </div>
              )}
              {snapshot.admissionLocked ? (
                <span className="pill pill-paused">Admission Locked (Rejoining Open)</span>
              ) : (
                <p>
                  Scan the code, then type a <strong>nickname</strong> and the{' '}
                  <strong>team number</strong> on your team's card.
                </p>
              )}
            </article>

            <article className={guidePanelClass('guide-motion', 3, 3)} aria-hidden={guideStep < 3}>
              <h2 className="guide-heading">
                <span className="guide-num">2</span> Allow Motion
              </h2>
              <ul>
                <li>
                  Tap <strong>Enable Motion</strong>. If your phone asks, choose{' '}
                  <strong>Allow</strong>.
                </li>
                <li>
                  <strong>Lock screen rotation</strong>, hold the phone upright facing you, then
                  keep still to calibrate.
                </li>
              </ul>
            </article>

            <article className={guidePanelClass('guide-game', 1, 1)}>
              <h2 className="guide-heading">The Game</h2>
              <ul>
                <li>
                  Your team shares <strong>one creature</strong>. Each player is{' '}
                  <strong>one limb</strong>.
                </li>
                <li>You keep the same team, limb, and sweep the whole time.</li>
                <li>
                  It is <strong>homuncular flexibility</strong> in action: a small sweep of your
                  phone is <strong>remapped</strong> onto a limb your own body does not have.
                </li>
              </ul>
            </article>

            <article className={guidePanelClass('guide-sweeps', 4, 4)} aria-hidden={guideStep < 4}>
              <h2 className="guide-heading">
                <span className="guide-num">3</span> Learn Your Sweep
              </h2>
              <SweepSteps layout="row" />
              <p>Your phone shows which sweep is yours. Small moves are enough, so stay seated.</p>
              <div className="guide-sweep-grid">
                {GESTURE_ASSIGNMENT_ORDER.map((gestureId) => (
                  <GestureDemoBadge key={gestureId} gestureId={gestureId} animate compact />
                ))}
              </div>
            </article>
          </div>
        </section>
      )}

      {/* The browser holds music back until this page is clicked once. Shown above everything, the guide included. */}
      {snapshot.musicEnabled && musicBlocked && !muted && (
        <button type="button" className="music-unlock-banner">
          <span className="music-unlock-icon" aria-hidden="true">
            ♪
          </span>
          Click anywhere on this screen to start the music
        </button>
      )}
    </main>
  );
};
