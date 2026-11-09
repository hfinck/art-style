import type { AppController } from '../controller';
import { Icon, UI_ICONS } from './Icon';

export function PaletteBar({ app }: { app: AppController }) {
  const palette = app.palette.value;
  if (!palette || !app.usesColor.value) return null;
  const selected = app.colorIndex.value;
  return (
    <div class="palette-bar">
      <button
        class={`swatch random ${selected < 0 ? 'active' : ''}`}
        aria-label="Random colours from palette"
        aria-pressed={selected < 0}
        onClick={() => app.selectColor(-1)}
        style={{ background: `conic-gradient(${palette.colors.join(',')},${palette.colors[0]})` }}
      >
        <Icon path={UI_ICONS.dice} size={18} />
      </button>
      <div class="swatches">
        {palette.colors.map((c, i) => (
          <button
            key={c + i}
            class={`swatch ${selected === i ? 'active' : ''}`}
            style={{ background: c }}
            aria-label={`Colour ${c}`}
            aria-pressed={selected === i}
            onClick={() => app.selectColor(i)}
          />
        ))}
      </div>
      <button class="palette-name" onClick={() => (app.sheet.value = 'palettes')}>
        <Icon path={UI_ICONS.palette} size={18} />
        <span>{palette.name}</span>
      </button>
    </div>
  );
}
