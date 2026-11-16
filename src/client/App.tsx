import React, { useEffect, useLayoutEffect, useState } from 'react';
import { ComicBurst } from './components/ComicBurst.js';
import { ControlView } from './views/ControlView.js';
import { PlayView } from './views/PlayView.js';
import { ScreenView } from './views/ScreenView.js';
import { SensorLabView } from './views/SensorLabView.js';

type Route = 'play' | 'screen' | 'control' | 'lab' | 'landing';

function resolveRoute(pathname: string): Route {
  const clean = pathname.replace(/\/+$/, '') || '/';
  if (clean === '/play') return 'play';
  if (clean === '/screen') return 'screen';
  if (clean === '/control') return 'control';
  if (clean === '/lab') return 'lab';
  return 'landing';
}

export const App: React.FC = () => {
  const [route, setRoute] = useState(() => resolveRoute(window.location.pathname));

  useEffect(() => {
    const onPop = () => setRoute(resolveRoute(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Each surface gets its own page color from the comic palette (see styles.css)
  useLayoutEffect(() => {
    document.documentElement.dataset.surface = route;
  }, [route]);

  if (route === 'play') return <PlayView />;
  if (route === 'screen') return <ScreenView />;
  if (route === 'control') return <ControlView />;
  if (route === 'lab') return <SensorLabView />;

  return (
    <main className="play-shell" style={{ maxWidth: 560, justifyContent: 'center' }}>
      <section className="onboard-panel">
        <span className="pad-pop pad-pop-corner" aria-hidden="true">
          <ComicBurst fill="#1fa8f2" seed={5} className="burst-wobble">
            <span className="comic-word" style={{ '--word-fill': '#ffffff' } as React.CSSProperties}>
              HEY!
            </span>
          </ComicBurst>
        </span>
        <h1>CS260B Shared-Body Pond Game</h1>
        <p>
          Teams of 4 to 6 participants collectively operate one swimming pond creature, with each
          phone controlling one paddle through a compact seated motion.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
          <a href="/play" className="btn-primary">
            Participant Phone Controller (/play)
          </a>
          <a href="/screen" className="btn-secondary">
            Classroom Projector Display (/screen)
          </a>
          <a href="/control" className="btn-subtle">
            Facilitator Mission Control (/control)
          </a>
          <a href="/lab" className="btn-subtle">
            Gate A Phone Sensor Laboratory (/lab)
          </a>
        </div>
      </section>
    </main>
  );
};
