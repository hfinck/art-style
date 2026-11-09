import type { GestureRecognizer, InputPoint, PointerKind } from './GestureRecognizer';

export interface PointerInputOptions {
  onWheel?(x: number, y: number, deltaY: number, pinch: boolean): void;
}

/**
 * Binds DOM pointer events to the gesture recognizer.
 *
 * - Uses coalesced events so fast strokes get every hardware sample (120–240 Hz).
 * - Blocks browser gestures (scroll, pinch-zoom, pull-to-refresh, long-press menus).
 */
export function bindPointerInput(el: HTMLElement, recognizer: GestureRecognizer, opts: PointerInputOptions = {}): () => void {
  const local = (e: PointerEvent | MouseEvent, t: number): InputPoint => {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, t };
  };

  const onDown = (e: PointerEvent) => {
    e.preventDefault();
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort */
    }
    recognizer.down(e.pointerId, local(e, e.timeStamp), e.pointerType as PointerKind, e.button);
  };

  const onMove = (e: PointerEvent) => {
    const coalesced = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    const events = coalesced.length > 0 ? coalesced : [e];
    const r = el.getBoundingClientRect();
    const pts = events.map((ev) => ({ x: ev.clientX - r.left, y: ev.clientY - r.top, t: ev.timeStamp || e.timeStamp }));
    recognizer.move(e.pointerId, pts);
  };

  const onUp = (e: PointerEvent) => {
    recognizer.up(e.pointerId, e.timeStamp);
  };

  const onCancel = (e: PointerEvent) => recognizer.cancel(e.pointerId);

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const p = local(e, e.timeStamp);
    opts.onWheel?.(p.x, p.y, e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY, e.ctrlKey);
  };

  const prevent = (e: Event) => e.preventDefault();
  const onBlur = () => recognizer.reset();

  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onCancel);
  el.addEventListener('lostpointercapture', onCancel);
  el.addEventListener('wheel', onWheel, { passive: false });
  el.addEventListener('contextmenu', prevent);
  // iOS Safari: block native pinch / double-tap zoom and scrolling on the canvas.
  el.addEventListener('touchstart', prevent, { passive: false });
  el.addEventListener('touchmove', prevent, { passive: false });
  el.addEventListener('gesturestart', prevent);
  window.addEventListener('blur', onBlur);

  return () => {
    el.removeEventListener('pointerdown', onDown);
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    el.removeEventListener('pointercancel', onCancel);
    el.removeEventListener('lostpointercapture', onCancel);
    el.removeEventListener('wheel', onWheel);
    el.removeEventListener('contextmenu', prevent);
    el.removeEventListener('touchstart', prevent);
    el.removeEventListener('touchmove', prevent);
    el.removeEventListener('gesturestart', prevent);
    window.removeEventListener('blur', onBlur);
  };
}
