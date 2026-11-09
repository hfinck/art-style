import type { AppController } from '../controller';
import { Icon, UI_ICONS } from './Icon';

export function ToolBar({ app }: { app: AppController }) {
  const plugin = app.plugin.value;
  const phase = app.phase.value;
  if (!plugin || !phase) return null;
  const active = app.tool.value?.id;
  const isLast = app.phaseIndex.value >= plugin.phases.length - 1;
  return (
    <div class="toolbar">
      <div class="tool-group">
        {phase.tools.map((id) => {
          const t = plugin.tools.find((x) => x.id === id)!;
          return (
            <button
              key={id}
              class={`tool ${active === id ? 'active' : ''}`}
              aria-pressed={active === id}
              onClick={() => app.selectTool(id)}
            >
              <Icon path={t.icon} />
              <span>{t.label}</span>
            </button>
          );
        })}
        {app.phaseActions.value.map((a) => (
          <button key={a.id} class="tool action" onClick={() => app.runAction(a.id)}>
            <Icon path={a.icon} />
            <span>{a.label}</span>
          </button>
        ))}
      </div>
      <div class="tool-group end">
        <button class="tool" aria-label="Tool settings" onClick={() => (app.sheet.value = 'settings')}>
          <Icon path={UI_ICONS.settings} />
          <span>Adjust</span>
        </button>
        {!isLast && (
          <button class="tool next" onClick={() => app.selectPhase(app.phaseIndex.value + 1)}>
            <Icon path={UI_ICONS.chevron} />
            <span>Next</span>
          </button>
        )}
      </div>
    </div>
  );
}
