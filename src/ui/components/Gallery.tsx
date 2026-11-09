import { useEffect, useMemo } from 'preact/hooks';
import type { AppController } from '../controller';
import { Icon, UI_ICONS } from './Icon';
import { Sheet } from './Sheet';

export function Gallery({ app }: { app: AppController }) {
  const items = app.gallery.value;
  const urls = useMemo(() => items.map((p) => (p.thumbnail ? URL.createObjectURL(p.thumbnail) : '')), [items]);
  useEffect(() => () => urls.forEach((u) => u && URL.revokeObjectURL(u)), [urls]);
  useEffect(() => void app.saveNow(), []);
  const currentId = app.project.value?.id;
  return (
    <Sheet title="My paintings" onClose={() => (app.sheet.value = 'none')}>
      <div class="gallery">
        <button class="gallery-item new" onClick={() => (app.sheet.value = 'new')}>
          <Icon path={UI_ICONS.plus} size={32} />
          <span>New painting</span>
        </button>
        {items.map((p, i) => (
          <div key={p.id} class={`gallery-item ${p.id === currentId ? 'current' : ''}`}>
            <button class="gallery-open" onClick={() => void app.openProject(p.id)} aria-label={`Open ${p.name}`}>
              {urls[i] ? <img src={urls[i]} alt="" /> : <span class="no-thumb" />}
            </button>
            <div class="gallery-meta">
              <span>{new Date(p.updatedAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}</span>
              <button
                class="icon-btn small"
                aria-label="Delete painting"
                onClick={() => {
                  if (confirm('Delete this painting?')) void app.deleteProject(p.id);
                }}
              >
                <Icon path={UI_ICONS.trash} size={18} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </Sheet>
  );
}
