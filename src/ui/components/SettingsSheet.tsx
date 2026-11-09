import type { SettingDef, SettingValues } from '@core/plugin-api';
import type { AppController } from '../controller';
import { Sheet } from './Sheet';

function Field({ def, value, onChange }: { def: SettingDef; value: unknown; onChange: (v: number | boolean) => void }) {
  if (def.type === 'range') {
    const v = typeof value === 'number' ? value : def.default;
    return (
      <label class="field">
        <span class="field-label">
          {def.label}
          <output>
            {Math.round(v)}
            {def.unit ?? ''}
          </output>
        </span>
        <input
          type="range"
          min={def.min}
          max={def.max}
          step={def.step ?? 1}
          value={v}
          onInput={(e) => onChange(Number((e.target as HTMLInputElement).value))}
        />
      </label>
    );
  }
  if (def.type === 'toggle') {
    const v = typeof value === 'boolean' ? value : def.default;
    return (
      <label class="field toggle">
        <span class="field-label">{def.label}</span>
        <input type="checkbox" checked={v} onChange={(e) => onChange((e.target as HTMLInputElement).checked)} />
      </label>
    );
  }
  return null; // colours are chosen in the palette bar
}

function Group({ app, id, label, defs, values }: { app: AppController; id: string; label: string; defs: SettingDef[]; values: SettingValues }) {
  const visible = defs.filter((d) => d.type !== 'color');
  if (visible.length === 0) return null;
  return (
    <div class="settings-group">
      <div class="settings-group-head">
        <h3>{label}</h3>
        <button class="link" onClick={() => app.resetSettings(id)}>
          Reset
        </button>
      </div>
      {visible.map((d) => (
        <Field key={d.id} def={d} value={values[d.id]} onChange={(v) => app.setSetting(id, d.id, v)} />
      ))}
    </div>
  );
}

/** Settings UI generated from the plugin's setting definitions. */
export function SettingsSheet({ app }: { app: AppController }) {
  const tool = app.tool.value;
  const settings = app.settings.value;
  const close = () => (app.sheet.value = 'none');
  return (
    <Sheet title="Adjust" onClose={close}>
      {tool && <Group app={app} id={tool.id} label={tool.label} defs={tool.settings} values={settings[tool.id] ?? {}} />}
      {app.phaseActions.value.map((a) => (
        <Group key={a.id} app={app} id={a.id} label={a.label} defs={a.settings} values={settings[a.id] ?? {}} />
      ))}
      <div class="settings-group">
        <button
          class="danger"
          onClick={() => {
            app.clear();
            close();
          }}
        >
          Clear canvas
        </button>
      </div>
    </Sheet>
  );
}

export function PaletteSheet({ app }: { app: AppController }) {
  const plugin = app.plugin.value;
  if (!plugin) return null;
  return (
    <Sheet title="Palettes" onClose={() => (app.sheet.value = 'none')}>
      <div class="palette-list">
        {plugin.palettes.map((p) => (
          <button
            key={p.id}
            class={`palette-row ${app.paletteId.value === p.id ? 'active' : ''}`}
            onClick={() => {
              app.selectPalette(p.id);
              app.sheet.value = 'none';
            }}
          >
            <span class="palette-row-name">{p.name}</span>
            <span class="palette-row-colors">
              {p.colors.map((c, i) => (
                <i key={i} style={{ background: c }} />
              ))}
            </span>
          </button>
        ))}
      </div>
    </Sheet>
  );
}
