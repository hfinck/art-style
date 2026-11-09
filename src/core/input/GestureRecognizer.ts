export interface InputPoint {
  x: number;
  y: number;
  t: number;
}

export type PointerKind = 'touch' | 'mouse' | 'pen';

export interface GestureHandlers {
  strokeStart(p: InputPoint): void;
  strokeMove(points: InputPoint[]): void;
  strokeEnd(): void;
  /** The stroke turned out to be the start of a multi-finger gesture: discard it. */
  strokeCancel(): void;
  /** Two-point transform: map the `from` pair onto the `to` pair (pan / pinch / rotate). */
  viewChange(from: [InputPoint, InputPoint], to: [InputPoint, InputPoint]): void;
  /** Quick tap with N fingers (2 = undo, 3 = redo). */
  tap(fingers: number): void;
  /** All fingers of a navigation gesture lifted. */
  gestureEnd?(): void;
}

export interface GestureOptions {
  /** A touch becomes a stroke after this many ms … */
  holdMs: number;
  /** … or after moving this many CSS px, whichever comes first. */
  slopPx: number;
  /** Max duration of a multi-finger tap. */
  tapMs: number;
  /** Max movement of a multi-finger tap. */
  tapSlopPx: number;
}

export const DEFAULT_GESTURE_OPTIONS: GestureOptions = {
  holdMs: 70,
  slopPx: 9,
  tapMs: 320,
  tapSlopPx: 18,
};

type State =
  | { kind: 'idle' }
  | { kind: 'pending'; id: number; points: InputPoint[] }
  | { kind: 'stroke'; id: number; last: InputPoint }
  | { kind: 'pan'; id: number; last: InputPoint }
  | {
      kind: 'multi';
      pointers: Map<number, InputPoint>;
      start: number;
      maxFingers: number;
      travelled: number;
      cancelledStroke: boolean;
    };

/**
 * Pure state machine that decides whether touches are painting or navigating.
 *
 * - 1 finger: paints. Painting starts after a short delay/slop so that a second finger
 *   arriving almost simultaneously turns it into a navigation gesture without marks.
 * - 2+ fingers: pan / pinch-zoom / rotate; a quick tap triggers `tap(n)`.
 * - Mouse: left button paints immediately; middle/right button pans.
 */
export class GestureRecognizer {
  private state: State = { kind: 'idle' };
  private readonly opts: GestureOptions;

  constructor(
    private readonly h: GestureHandlers,
    opts: Partial<GestureOptions> = {},
  ) {
    this.opts = { ...DEFAULT_GESTURE_OPTIONS, ...opts };
  }

  get isPainting(): boolean {
    return this.state.kind === 'stroke';
  }

  down(id: number, p: InputPoint, kind: PointerKind = 'touch', button = 0): void {
    const s = this.state;
    if (kind === 'mouse') {
      if (s.kind !== 'idle') return;
      if (button === 0) {
        this.state = { kind: 'stroke', id, last: p };
        this.h.strokeStart(p);
      } else {
        this.state = { kind: 'pan', id, last: p };
      }
      return;
    }
    switch (s.kind) {
      case 'idle':
        this.state = { kind: 'pending', id, points: [p] };
        return;
      case 'pending': {
        const first = s.points[s.points.length - 1]!;
        this.toMulti(new Map([[s.id, first], [id, p]]), s.points[0]!.t, false);
        return;
      }
      case 'stroke':
        this.h.strokeCancel();
        this.toMulti(new Map([[s.id, s.last], [id, p]]), p.t, true);
        return;
      case 'multi':
        s.pointers.set(id, p);
        s.maxFingers = Math.max(s.maxFingers, s.pointers.size);
        return;
      case 'pan':
        return;
    }
  }

  move(id: number, points: InputPoint[]): void {
    if (points.length === 0) return;
    const s = this.state;
    switch (s.kind) {
      case 'pending': {
        if (id !== s.id) return;
        s.points.push(...points);
        const first = s.points[0]!;
        const last = s.points[s.points.length - 1]!;
        const moved = Math.hypot(last.x - first.x, last.y - first.y);
        if (moved >= this.opts.slopPx || last.t - first.t >= this.opts.holdMs) {
          this.state = { kind: 'stroke', id, last };
          this.h.strokeStart(first);
          if (s.points.length > 1) this.h.strokeMove(s.points.slice(1));
        }
        return;
      }
      case 'stroke':
        if (id !== s.id) return;
        s.last = points[points.length - 1]!;
        this.h.strokeMove(points);
        return;
      case 'pan': {
        if (id !== s.id) return;
        const to = points[points.length - 1]!;
        // A pure translation expressed as a two-point transform.
        this.h.viewChange(
          [s.last, { x: s.last.x + 100, y: s.last.y, t: s.last.t }],
          [to, { x: to.x + 100, y: to.y, t: to.t }],
        );
        s.last = to;
        return;
      }
      case 'multi': {
        const prev = s.pointers.get(id);
        if (!prev) return;
        const next = points[points.length - 1]!;
        const ids = [...s.pointers.keys()];
        const before = ids.slice(0, 2).map((k) => s.pointers.get(k)!) as [InputPoint, InputPoint];
        s.pointers.set(id, next);
        s.travelled += Math.hypot(next.x - prev.x, next.y - prev.y);
        if (s.pointers.size >= 2 && ids.indexOf(id) < 2) {
          const after = ids.slice(0, 2).map((k) => s.pointers.get(k)!) as [InputPoint, InputPoint];
          this.h.viewChange(before, after);
        }
        return;
      }
      case 'idle':
        return;
    }
  }

  up(id: number, t: number): void {
    const s = this.state;
    switch (s.kind) {
      case 'pending':
        if (id !== s.id) return;
        // A quick single tap: still a (very short) stroke, e.g. dropping a blob.
        this.state = { kind: 'idle' };
        this.h.strokeStart(s.points[0]!);
        if (s.points.length > 1) this.h.strokeMove(s.points.slice(1));
        this.h.strokeEnd();
        return;
      case 'stroke':
        if (id !== s.id) return;
        this.state = { kind: 'idle' };
        this.h.strokeEnd();
        return;
      case 'pan':
        if (id === s.id) {
          this.state = { kind: 'idle' };
          this.h.gestureEnd?.();
        }
        return;
      case 'multi':
        s.pointers.delete(id);
        if (s.pointers.size === 0) {
          const isTap =
            !s.cancelledStroke &&
            t - s.start <= this.opts.tapMs &&
            s.travelled <= this.opts.tapSlopPx * s.maxFingers;
          this.state = { kind: 'idle' };
          this.h.gestureEnd?.();
          if (isTap) this.h.tap(s.maxFingers);
        }
        return;
      case 'idle':
        return;
    }
  }

  /** Pointer cancelled by the browser/OS: never leave a half-painted stroke behind. */
  cancel(id: number): void {
    const s = this.state;
    if (s.kind === 'stroke' && s.id === id) {
      this.state = { kind: 'idle' };
      this.h.strokeEnd();
    } else if (s.kind === 'pending' && s.id === id) {
      this.state = { kind: 'idle' };
    } else if (s.kind === 'pan' && s.id === id) {
      this.state = { kind: 'idle' };
    } else if (s.kind === 'multi' && s.pointers.has(id)) {
      s.pointers.delete(id);
      s.cancelledStroke = true; // never treat as a tap
      if (s.pointers.size === 0) this.state = { kind: 'idle' };
    }
  }

  /** Abort everything (e.g. app lost focus). */
  reset(): void {
    if (this.state.kind === 'stroke') this.h.strokeEnd();
    this.state = { kind: 'idle' };
  }

  private toMulti(pointers: Map<number, InputPoint>, start: number, cancelledStroke: boolean): void {
    this.state = { kind: 'multi', pointers, start, maxFingers: pointers.size, travelled: 0, cancelledStroke };
  }
}
