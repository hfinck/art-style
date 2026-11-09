import { useEffect, useRef } from 'preact/hooks';
import type { AppController } from './controller';
import { Gallery } from './components/Gallery';
import { Icon, UI_ICONS } from './components/Icon';
import { NewSheet } from './components/NewSheet';
import { BusyOverlay, ErrorBanner, Hint } from './components/Overlays';
import { PaletteBar } from './components/PaletteBar';
import { PhaseBar } from './components/PhaseBar';
import { PaletteSheet, SettingsSheet } from './components/SettingsSheet';
import { ToolBar } from './components/ToolBar';
import { TopBar } from './components/TopBar';

/** The canvas is created once and handed to the engine; Preact never re-renders it. */
function Stage({ app }: { app: AppController }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) void app.attach(ref.current);
  }, []);
  return (
    <main class="stage">
      <canvas ref={ref} class="paint-canvas" aria-label="Painting canvas" />
      <button class="fab fit" aria-label="Fit canvas to screen" onClick={() => app.fit()}>
        <Icon path={UI_ICONS.fit} size={20} />
      </button>
      <Hint app={app} />
      <BusyOverlay app={app} />
    </main>
  );
}

export function App({ app }: { app: AppController }) {
  const sheet = app.sheet.value;
  return (
    <div class="app">
      <TopBar app={app} />
      <Stage app={app} />
      <footer class="panel">
        <PhaseBar app={app} />
        <PaletteBar app={app} />
        <ToolBar app={app} />
      </footer>
      {sheet === 'settings' && <SettingsSheet app={app} />}
      {sheet === 'palettes' && <PaletteSheet app={app} />}
      {sheet === 'new' && <NewSheet app={app} />}
      {sheet === 'gallery' && <Gallery app={app} />}
      <ErrorBanner app={app} />
    </div>
  );
}
