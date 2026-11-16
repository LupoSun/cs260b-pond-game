import React from 'react';
import { GESTURE_SPECS } from '../../shared/constants.js';
import type { GestureId } from '../../shared/types.js';

interface GestureDemoBadgeProps {
  gestureId: GestureId;
  animate: boolean;
  onToggleAnimate?: () => void;
  compact?: boolean;
}

const INK = '#14121f';

/**
 * Displays the player's immutable directional arrow, start/end markers, and an optional
 * looping animated puck showing "Hold & sweep -> Release to return".
 * Drawn as a small comic panel: halftone backdrop, inked chunky arrow, speed ticks at the tail.
 */
export const GestureDemoBadge: React.FC<GestureDemoBadgeProps> = ({
  gestureId,
  animate,
  onToggleAnimate,
  compact = false,
}) => {
  const spec = GESTURE_SPECS[gestureId];
  // Convert screen plane (+x right, +y up) to SVG coordinates (+x right, +y down)
  const dx = spec.desiredDir.x;
  const dySvg = -spec.desiredDir.y;

  const cx = 56;
  const cy = 56;
  const halfSpan = 30;
  const startX = cx - dx * halfSpan;
  const startY = cy - dySvg * halfSpan;
  const endX = cx + dx * halfSpan;
  const endY = cy + dySvg * halfSpan;

  // Chunky arrowhead triangle
  const angle = Math.atan2(dySvg, dx);
  const headLen = 20;
  const headHalfWidth = 14;
  const tipX = endX + Math.cos(angle) * 7;
  const tipY = endY + Math.sin(angle) * 7;
  const baseX = tipX - Math.cos(angle) * headLen;
  const baseY = tipY - Math.sin(angle) * headLen;
  const nx = -Math.sin(angle);
  const ny = Math.cos(angle);
  const headPoints = `${tipX},${tipY} ${baseX + nx * headHalfWidth},${baseY + ny * headHalfWidth} ${
    baseX - nx * headHalfWidth
  },${baseY - ny * headHalfWidth}`;

  // Speed ticks trailing behind the start marker
  const ticks = [-9, 0, 9].map((offset) => {
    const ox = startX + nx * offset - Math.cos(angle) * 12;
    const oy = startY + ny * offset - Math.sin(angle) * 12;
    const len = offset === 0 ? 9 : 6;
    return {
      x1: ox,
      y1: oy,
      x2: ox - Math.cos(angle) * len,
      y2: oy - Math.sin(angle) * len,
    };
  });

  const patternId = `gesture-dots-${gestureId}`;

  return (
    <div className={`gesture-demo-box ${compact ? 'gesture-demo-compact' : ''}`}>
      <svg
        viewBox="0 0 112 112"
        className="gesture-demo-svg"
        role="img"
        aria-label={spec.instruction}
      >
        <defs>
          <pattern id={patternId} width="9" height="9" patternUnits="userSpaceOnUse">
            <circle cx="2.2" cy="2.2" r="1.5" fill="#ffffff" opacity="0.55" />
            <circle cx="6.7" cy="6.7" r="1.5" fill="#ffffff" opacity="0.55" />
          </pattern>
        </defs>
        <rect x="9" y="10" width="98" height="98" rx="10" fill={INK} />
        <rect x="5" y="5" width="98" height="98" rx="10" fill="#1fa8f2" stroke={INK} strokeWidth="4" />
        <rect x="7" y="7" width="94" height="94" rx="8" fill={`url(#${patternId})`} />

        {/* Speed ticks */}
        {ticks.map((t, i) => (
          <line
            key={i}
            x1={t.x1}
            y1={t.y1}
            x2={t.x2}
            y2={t.y2}
            stroke={INK}
            strokeWidth="3"
            strokeLinecap="round"
          />
        ))}

        {/* Arrow shaft: ink underlay, yellow fill */}
        <line
          x1={startX}
          y1={startY}
          x2={baseX}
          y2={baseY}
          stroke={INK}
          strokeWidth="15"
          strokeLinecap="round"
        />
        <polygon
          points={headPoints}
          fill="#ffd91a"
          stroke={INK}
          strokeWidth="4"
          strokeLinejoin="round"
        />
        <line
          x1={startX}
          y1={startY}
          x2={baseX + Math.cos(angle) * 3}
          y2={baseY + Math.sin(angle) * 3}
          stroke="#ffd91a"
          strokeWidth="8"
          strokeLinecap="round"
        />

        {/* Start marker */}
        <circle cx={startX} cy={startY} r="7.5" fill="#ffffff" stroke={INK} strokeWidth="3" />

        {/* Looping animated hand puck (respects prefers-reduced-motion in CSS + manual toggle) */}
        {animate && (
          <circle r="8.5" fill="#ff5aa5" stroke={INK} strokeWidth="3" className="gesture-puck">
            <animateMotion
              dur="1.45s"
              repeatCount="indefinite"
              path={`M ${startX} ${startY} L ${endX} ${endY}`}
              keyTimes="0;0.65;1"
              keyPoints="0;1;1"
              calcMode="spline"
              keySplines="0.22 1 0.36 1; 0 0 1 1"
            />
          </circle>
        )}
      </svg>
      <div className="gesture-demo-meta">
        <div className="gesture-demo-title">{spec.instruction}</div>
        <div className="gesture-demo-sub">Hold to sweep · Release to return</div>
        {onToggleAnimate && (
          <button
            type="button"
            className="btn-subtle btn-xs"
            onClick={onToggleAnimate}
          >
            {animate ? 'Pause demo' : 'Replay demo'}
          </button>
        )}
      </div>
    </div>
  );
};
