import React, { useEffect, useRef } from 'react';
import type { TeamPublicState } from '../../shared/types.js';
import { FeedbackController } from '../feedback.js';
import {
  drawCardBackdrop,
  drawModularCreature,
  type TransientVisualEffects,
} from '../pondRenderer.js';

interface CreatureCardCanvasProps {
  team: TeamPublicState;
  effects?: TransientVisualEffects;
  focusLimbIndex?: number | null;
  localFocusLimbHeld?: boolean;
  localFocusLimbProgress?: number;
  isPaused?: boolean;
  width?: number;
  height?: number;
  headingRad?: number;
}

export const CreatureCardCanvas: React.FC<CreatureCardCanvasProps> = ({
  team,
  effects,
  focusLimbIndex = null,
  localFocusLimbHeld,
  localFocusLimbProgress,
  isPaused = false,
  width = 360,
  height = 200,
  headingRad = 0,
}) => {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const measuredSizeRef = useRef({ w: width, h: height });

  const latestPropsRef = useRef({
    team,
    effects,
    focusLimbIndex,
    localFocusLimbHeld,
    localFocusLimbProgress,
    isPaused,
    width,
    height,
    headingRad,
  });
  latestPropsRef.current = {
    team,
    effects,
    focusLimbIndex,
    localFocusLimbHeld,
    localFocusLimbProgress,
    isPaused,
    width,
    height,
    headingRad,
  };

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || typeof ResizeObserver === 'undefined') return;

    const updateBox = () => {
      const cw = wrap.clientWidth;
      const ch = wrap.clientHeight;
      if (cw > 20 && ch > 20) {
        measuredSizeRef.current = { w: cw, h: ch };
      }
    };
    updateBox();

    const ro = new ResizeObserver(() => updateBox());
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let rafId = 0;
    const reducedMotion = FeedbackController.prefersReducedMotion();

    const render = (nowMs: number) => {
      const canvas = canvasRef.current;
      if (canvas) {
        const {
          team: curTeam,
          effects: curEffects,
          focusLimbIndex: curFocus,
          localFocusLimbHeld: curHeld,
          localFocusLimbProgress: curProg,
          isPaused: curPaused,
          width: fallbackW,
          height: fallbackH,
          headingRad: curHeading,
        } = latestPropsRef.current;

        const w = measuredSizeRef.current.w > 20 ? measuredSizeRef.current.w : fallbackW;
        const h = measuredSizeRef.current.h > 20 ? measuredSizeRef.current.h : fallbackH;

        const dpr = Math.min(2, window.devicePixelRatio || 1);
        if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
          canvas.width = Math.round(w * dpr);
          canvas.height = Math.round(h * dpr);
        }

        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.save();
          ctx.scale(dpr, dpr);

          // Comic panel backdrop: team-tinted speed-line rays with an inked pond in the middle
          drawCardBackdrop(
            ctx,
            w,
            h,
            curTeam.colorHex,
            curTeam.teamNumber,
            nowMs,
            reducedMotion || curPaused,
          );

          // Scale creature radius proportionally to dynamic card size while guaranteeing zero paddle/pill clipping
          const maxRadiusFromH = (h * 0.5 - 26) / 1.86;
          const maxRadiusFromW = (w * 0.5 - 34) / 1.86;
          const bodyR = Math.max(18, Math.min(82, maxRadiusFromH, maxRadiusFromW));

          // Small anchored forward nudge during training (never leaves card!)
          const nudgePx = reducedMotion ? 0 : (curTeam.sim.trainingPulse ?? 0) * Math.min(18, w * 0.04);
          const cx = w * 0.49 + Math.cos(curHeading) * nudgePx;
          const cy = h * 0.51 + Math.sin(curHeading) * nudgePx;

          drawModularCreature({
            ctx,
            team: curTeam,
            centerX: cx,
            centerY: cy,
            headingRad: curHeading,
            bodyRadius: bodyR,
            nowMs,
            reducedMotion,
            effects: curEffects,
            focusLimbIndex: curFocus,
            localFocusLimbHeld: curHeld,
            localFocusLimbProgress: curProg,
            showLimbLabels: true,
            isPaused: curPaused,
          });

          ctx.restore();
        }
      }
      rafId = window.requestAnimationFrame(render);
    };

    rafId = window.requestAnimationFrame(render);
    return () => window.cancelAnimationFrame(rafId);
  }, []);

  return (
    <div ref={wrapRef} className="pond-card-canvas-wrap">
      <canvas
        ref={canvasRef}
        className="pond-card-canvas"
        aria-label={`Team ${team.teamNumber} pond creature with ${team.limbCount} ${
          team.limbCount === 1 ? 'paddle' : 'paddles'
        }`}
      />
    </div>
  );
};
