import { useState } from 'preact/hooks';
import { FORMATS } from '../../core/engine/formats';
import type { AppController } from '../controller';
import { Sheet } from './Sheet';

export function NewSheet({ app }: { app: AppController }) {
  const styles = app.styles.value;
  const [styleId, setStyleId] = useState(app.plugin.value?.manifest.id ?? styles[0]?.manifest.id ?? '');
  const [formatId, setFormatId] = useState(app.project.value?.formatId ?? FORMATS[0]!.id);
  const canClose = (app.project.value?.commands.length ?? 0) > 0 || app.canUndo.value;
  return (
    <Sheet title="New painting" onClose={canClose ? () => (app.sheet.value = 'none') : () => void app.newPainting(styleId, formatId)}>
      <h3 class="section-title">Style</h3>
      <div class="style-list">
        {styles.map((s) => (
          <button
            key={s.manifest.id}
            class={`style-card ${styleId === s.manifest.id ? 'active' : ''}`}
            onClick={() => setStyleId(s.manifest.id)}
          >
            <strong>{s.manifest.name}</strong>
            <span>{s.manifest.description}</span>
            {s.manifest.credit && <em>{s.manifest.credit}</em>}
          </button>
        ))}
      </div>
      <h3 class="section-title">Format</h3>
      <div class="format-grid">
        {FORMATS.map((f) => {
          const w = f.ratio >= 1 ? 44 : 44 * f.ratio;
          const h = f.ratio >= 1 ? 44 / f.ratio : 44;
          return (
            <button
              key={f.id}
              class={`format ${formatId === f.id ? 'active' : ''}`}
              onClick={() => setFormatId(f.id)}
              aria-pressed={formatId === f.id}
            >
              <span class="format-box" style={{ width: `${w}px`, height: `${h}px` }} />
              <span class="format-id">{f.id}</span>
              <span class="format-label">{f.label}</span>
            </button>
          );
        })}
      </div>
      <button class="primary wide" onClick={() => void app.newPainting(styleId, formatId)}>
        Start painting
      </button>
    </Sheet>
  );
}
