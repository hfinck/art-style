import type { AppController } from '../controller';
import { Icon, UI_ICONS } from './Icon';

export function TopBar({ app }: { app: AppController }) {
  const plugin = app.plugin.value;
  return (
    <header class="topbar">
      <button class="icon-btn" aria-label="My paintings" onClick={() => (app.sheet.value = 'gallery')}>
        <Icon path={UI_ICONS.gallery} />
      </button>
      <div class="title">
        <span class="title-main">{plugin?.manifest.name ?? 'Art Style Studio'}</span>
        {plugin?.manifest.credit && <span class="title-sub">{plugin.manifest.credit}</span>}
      </div>
      <button class="icon-btn" aria-label="Undo" disabled={!app.canUndo.value} onClick={() => app.undo()}>
        <Icon path={UI_ICONS.undo} />
      </button>
      <button class="icon-btn" aria-label="Redo" disabled={!app.canRedo.value} onClick={() => app.redo()}>
        <Icon path={UI_ICONS.redo} />
      </button>
      <button class="icon-btn" aria-label="Export image" onClick={() => void app.exportImage()}>
        <Icon path={UI_ICONS.share} />
      </button>
    </header>
  );
}
