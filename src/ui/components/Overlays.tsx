import { useEffect, useState } from 'preact/hooks';
import type { AppController } from '../controller';

export function BusyOverlay({ app }: { app: AppController }) {
  const busy = app.busy.value;
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!busy) {
      setShow(false);
      return;
    }
    // Only show for operations that take noticeably long.
    const t = setTimeout(() => setShow(true), 220);
    return () => clearTimeout(t);
  }, [busy]);
  if (!show) return null;
  return (
    <div class="busy" role="status">
      <div class="spinner" />
      <div class="busy-bar">
        <i style={{ width: `${Math.round(app.progress.value * 100)}%` }} />
      </div>
    </div>
  );
}

export function Hint({ app }: { app: AppController }) {
  const text = app.hint.value;
  if (!text) return null;
  return (
    <div class="hint" role="status" onClick={() => (app.hint.value = null)}>
      {text}
    </div>
  );
}

export function ErrorBanner({ app }: { app: AppController }) {
  const msg = app.error.value;
  if (!msg) return null;
  return (
    <div class="error" role="alert">
      <strong>Something went wrong.</strong>
      <span>{msg}</span>
      <button onClick={() => (app.error.value = null)}>Dismiss</button>
    </div>
  );
}
