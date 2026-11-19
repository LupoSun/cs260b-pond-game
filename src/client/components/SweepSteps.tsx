import React from 'react';

export type SweepStage = 'press' | 'move' | 'release';

const SWEEP_STAGES: ReadonlyArray<{ id: SweepStage; word: string; detail: string }> = [
  { id: 'press', word: 'Press', detail: 'and hold the big button' },
  { id: 'move', word: 'Move', detail: 'the phone along your arrow' },
  { id: 'release', word: 'Release', detail: 'then bring the phone back' },
];

/**
 * The one sequence every stroke follows: Press, Move, Release.
 *
 * - `stage` given: the compact strip on the phone's pad, lighting the beat the player is on now.
 * - `layout="list"`: a static explanation with a line of detail per beat (phone onboarding).
 * - `layout="row"`: the same explanation side by side (how-to-play guide on the display).
 * - `layout="display"`: large type for the classroom display, cycling through the three beats.
 */
export const SweepSteps: React.FC<{
  stage?: SweepStage;
  layout?: 'list' | 'row' | 'display';
}> = ({ stage, layout = 'list' }) => {
  const activeIndex = stage ? SWEEP_STAGES.findIndex((st) => st.id === stage) : -1;
  const variant = stage ? 'sweep-steps-live' : `sweep-steps-explain sweep-steps-${layout}`;
  return (
    <ol className={`sweep-steps ${variant}`} aria-label="Every stroke: press, move, release">
      {SWEEP_STAGES.map((st, i) => (
        <li
          key={st.id}
          className={`sweep-step ${i === activeIndex ? 'is-now' : ''} ${stage && i < activeIndex ? 'is-done' : ''}`}
          aria-current={i === activeIndex ? 'step' : undefined}
          style={{ '--i': i } as React.CSSProperties}
        >
          <span className="sweep-step-num" aria-hidden="true">
            {i + 1}
          </span>
          <span className="sweep-step-word">{st.word}</span>
          {!stage && <span className="sweep-step-detail">{st.detail}</span>}
        </li>
      ))}
    </ol>
  );
};
