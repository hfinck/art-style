import type { Stamp } from '../plugin-api/types';

interface Pt {
  x: number;
  y: number;
}

/**
 * Turns an irregular list of input points into evenly spaced stamps along a
 * centripetal Catmull–Rom spline, with a smoothed direction of travel.
 *
 * Deterministic: the same points always produce the same stamps, regardless of how
 * they are chunked. This is what makes undo-by-replay exact.
 */
export class StrokeResampler {
  private ctrl: Pt[] = [];
  private carry = 0; // distance travelled since the last stamp
  private distance = 0;
  private index = 0;
  private dir: Pt | null = null;
  private prevStamp: Stamp | null = null;
  /** Stamps held back until the initial direction is known. */
  private buffered: Pt[] = [];
  private bufferedDistances: number[] = [];
  private start: Pt | null = null;
  private finished = false;

  private readonly initDistance: number;

  constructor(
    private readonly spacing: number,
    private readonly directionSmoothing: number,
    private readonly emit: (s: Stamp) => void,
  ) {
    if (!(spacing > 0)) throw new Error('spacing must be > 0');
    this.initDistance = Math.min(24, Math.max(spacing, directionSmoothing * 0.5, 4));
  }

  add(x: number, y: number): void {
    if (this.finished) return;
    const p = { x, y };
    if (this.ctrl.length === 0) {
      this.ctrl.push(p, p);
      this.start = p;
      this.queue(p, 0);
      return;
    }
    const prev = this.ctrl[this.ctrl.length - 1]!;
    if (Math.hypot(p.x - prev.x, p.y - prev.y) < 0.05) return;
    this.ctrl.push(p);
    if (this.ctrl.length >= 4) {
      this.segment(this.ctrl[0]!, this.ctrl[1]!, this.ctrl[2]!, this.ctrl[3]!);
      this.ctrl.shift();
    }
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    if (this.ctrl.length === 0) return;
    const lastPt = this.ctrl[this.ctrl.length - 1]!;
    this.ctrl.push(lastPt);
    if (this.ctrl.length >= 4) {
      this.segment(this.ctrl[0]!, this.ctrl[1]!, this.ctrl[2]!, this.ctrl[3]!);
    }
    this.flushBuffered(true);
  }

  private segment(p0: Pt, p1: Pt, p2: Pt, p3: Pt): void {
    const chord = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const n = Math.min(128, Math.max(1, Math.ceil(chord / 1.5)));
    let a = p1;
    for (let i = 1; i <= n; i++) {
      const b = i === n ? p2 : catmullRom(p0, p1, p2, p3, i / n);
      this.walk(a, b);
      a = b;
    }
  }

  private walk(a: Pt, b: Pt): void {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len === 0) return;
    let pos = 0;
    while (this.carry + (len - pos) >= this.spacing) {
      pos += this.spacing - this.carry;
      this.carry = 0;
      const t = pos / len;
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      this.queue(p, this.spacing);
    }
    this.carry += len - pos;
  }

  private queue(p: Pt, step: number): void {
    this.distance += step;
    if (this.dir === null) {
      this.buffered.push(p);
      this.bufferedDistances.push(this.distance);
      this.index++;
      const s = this.start!;
      const d = Math.hypot(p.x - s.x, p.y - s.y);
      if (d >= this.initDistance) {
        this.dir = { x: (p.x - s.x) / d, y: (p.y - s.y) / d };
        this.flushBuffered(false);
      }
      return;
    }
    this.index++;
    this.output(p, this.distance);
  }

  private flushBuffered(final: boolean): void {
    if (this.buffered.length === 0) return;
    if (this.dir === null) {
      if (!final) return;
      // A tap or tiny stroke: use the overall direction if any, else default to +x.
      const s = this.start!;
      const e = this.buffered[this.buffered.length - 1]!;
      const d = Math.hypot(e.x - s.x, e.y - s.y);
      this.dir = d > 1e-3 ? { x: (e.x - s.x) / d, y: (e.y - s.y) / d } : { x: 1, y: 0 };
    }
    const pts = this.buffered;
    const dists = this.bufferedDistances;
    this.buffered = [];
    this.bufferedDistances = [];
    pts.forEach((p, i) => this.output(p, dists[i]!));
  }

  private output(p: Pt, distance: number): void {
    const prev = this.prevStamp;
    let dir = this.dir!;
    if (prev) {
      const dx = p.x - prev.x;
      const dy = p.y - prev.y;
      const len = Math.hypot(dx, dy);
      if (len > 1e-6) {
        const alpha = this.directionSmoothing > 0 ? 1 - Math.exp(-len / this.directionSmoothing) : 1;
        let nx = dir.x + (dx / len - dir.x) * alpha;
        let ny = dir.y + (dy / len - dir.y) * alpha;
        const nl = Math.hypot(nx, ny);
        if (nl > 1e-6) {
          nx /= nl;
          ny /= nl;
          dir = { x: nx, y: ny };
        }
      }
    }
    this.dir = dir;
    const stamp: Stamp = {
      index: prev ? prev.index + 1 : 0,
      x: p.x,
      y: p.y,
      prevX: prev ? prev.x : p.x,
      prevY: prev ? prev.y : p.y,
      dirX: dir.x,
      dirY: dir.y,
      prevDirX: prev ? prev.dirX : dir.x,
      prevDirY: prev ? prev.dirY : dir.y,
      distance,
    };
    this.prevStamp = stamp;
    this.emit(stamp);
  }
}

/** Centripetal Catmull–Rom (alpha = 0.5), Barry–Goldman formulation. */
function catmullRom(p0: Pt, p1: Pt, p2: Pt, p3: Pt, u: number): Pt {
  const knot = (a: Pt, b: Pt) => Math.max(1e-4, Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y)));
  const t0 = 0;
  const t1 = t0 + knot(p0, p1);
  const t2 = t1 + knot(p1, p2);
  const t3 = t2 + knot(p2, p3);
  const t = t1 + (t2 - t1) * u;
  const mix = (a: Pt, b: Pt, ta: number, tb: number): Pt => {
    const w = (t - ta) / (tb - ta);
    return { x: a.x + (b.x - a.x) * w, y: a.y + (b.y - a.y) * w };
  };
  const a1 = mix(p0, p1, t0, t1);
  const a2 = mix(p1, p2, t1, t2);
  const a3 = mix(p2, p3, t2, t3);
  const b1 = mix(a1, a2, t0, t2);
  const b2 = mix(a2, a3, t1, t3);
  return mix(b1, b2, t1, t2);
}
