import React from 'react';
import { createRoot } from 'react-dom/client';
// Self-hosted comic lettering (bundled by Vite; no external font requests in the classroom)
import '@fontsource/bangers/400.css';
import '@fontsource/comic-neue/400.css';
import '@fontsource/comic-neue/700.css';
import { App } from './App.js';
import './styles.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root #root element missing in index.html');
}

// Canvas lettering needs the faces loaded explicitly; redraws pick them up on the next frame.
if (typeof document !== 'undefined' && 'fonts' in document) {
  void document.fonts.load('400 24px Bangers');
  void document.fonts.load('700 14px "Comic Neue"');
}

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
