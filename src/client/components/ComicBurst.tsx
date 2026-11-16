import React from 'react';

interface ComicBurstProps {
  /** Fill color of the starburst shape */
  fill?: string;
  /** Number of spikes around the burst */
  spikes?: number;
  /** Seed so different callouts get different silhouettes */
  seed?: number;
  className?: string;
  children?: React.ReactNode;
}

const INK = '#14121f';

/** Deterministic irregular starburst outline in a 200 x 200 box (stable across renders). */
function buildBurstPoints(spikes: number, seed: number): string {
  const pts: string[] = [];
  const total = spikes * 2;
  for (let i = 0; i < total; i++) {
    const wobble = Math.sin((i + 1) * 12.9898 + seed * 78.233) * 43758.5453;
    const rand = wobble - Math.floor(wobble);
    const isOuter = i % 2 === 0;
    const radius = isOuter ? 86 + rand * 12 : 60 + rand * 8;
    const angle = (i / total) * Math.PI * 2 - Math.PI / 2 + (rand - 0.5) * 0.09;
    pts.push(`${(100 + Math.cos(angle) * radius).toFixed(1)},${(100 + Math.sin(angle) * radius).toFixed(1)}`);
  }
  return pts.join(' ');
}

/**
 * Comic starburst callout: an inked, hard-shadowed spiky shape stretched behind its label.
 * Purely decorative; the label text carries the meaning.
 */
export const ComicBurst: React.FC<ComicBurstProps> = ({
  fill = '#ffd91a',
  spikes = 13,
  seed = 1,
  className = '',
  children,
}) => {
  const points = buildBurstPoints(spikes, seed);
  return (
    <span className={`comic-burst ${className}`}>
      <svg viewBox="0 0 200 200" preserveAspectRatio="none" aria-hidden="true" focusable="false">
        <polygon points={points} fill={INK} transform="translate(7 8)" />
        <polygon
          points={points}
          fill={fill}
          stroke={INK}
          strokeWidth="4.5"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <span className="comic-burst-label">{children}</span>
    </span>
  );
};
