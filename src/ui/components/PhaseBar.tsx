import type { AppController } from '../controller';
import { Icon } from './Icon';

/** Guided steps of the style's workflow. Steps can be revisited at any time. */
export function PhaseBar({ app }: { app: AppController }) {
  const plugin = app.plugin.value;
  if (!plugin) return null;
  const current = app.phaseIndex.value;
  return (
    <nav class="phases" aria-label="Steps">
      {plugin.phases.map((ph, i) => (
        <button
          key={ph.id}
          class={`phase ${i === current ? 'active' : ''} ${i < current ? 'done' : ''}`}
          aria-current={i === current ? 'step' : undefined}
          onClick={() => app.selectPhase(i)}
        >
          <span class="phase-num">{i + 1}</span>
          <Icon path={ph.icon} size={18} />
          <span class="phase-label">{ph.label}</span>
        </button>
      ))}
    </nav>
  );
}
