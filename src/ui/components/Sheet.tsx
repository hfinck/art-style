import type { ComponentChildren } from 'preact';
import { Icon, UI_ICONS } from './Icon';

/** Bottom sheet on phones, centred panel on larger screens. */
export function Sheet({ title, onClose, children }: { title: string; onClose?: () => void; children: ComponentChildren }) {
  return (
    <div class="sheet-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <section class="sheet" role="dialog" aria-label={title}>
        <header class="sheet-head">
          <h2>{title}</h2>
          {onClose && (
            <button class="icon-btn" aria-label="Close" onClick={onClose}>
              <Icon path={UI_ICONS.close} />
            </button>
          )}
        </header>
        <div class="sheet-body">{children}</div>
      </section>
    </div>
  );
}
