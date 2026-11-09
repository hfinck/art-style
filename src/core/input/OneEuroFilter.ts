/**
 * One-euro filter (Casiez et al. 2012): removes jitter at low speed while keeping
 * latency low at high speed. Applied to touch positions before they become strokes.
 */
export class OneEuroFilter {
  private xPrev: number | null = null;
  private dxPrev = 0;
  private tPrev = 0;

  constructor(
    private readonly minCutoff = 1.5,
    private readonly beta = 0.02,
    private readonly dCutoff = 1.0,
  ) {}

  reset(): void {
    this.xPrev = null;
    this.dxPrev = 0;
  }

  /** @param t time in milliseconds */
  filter(x: number, t: number): number {
    if (this.xPrev === null) {
      this.xPrev = x;
      this.tPrev = t;
      return x;
    }
    const dt = Math.max(1e-3, (t - this.tPrev) / 1000);
    this.tPrev = t;
    const dx = (x - this.xPrev) / dt;
    const edx = lerp(this.dxPrev, dx, alpha(dt, this.dCutoff));
    this.dxPrev = edx;
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    const result = lerp(this.xPrev, x, alpha(dt, cutoff));
    this.xPrev = result;
    return result;
  }
}

/** Two independent one-euro filters for 2-D points. */
export class PointFilter {
  private readonly fx: OneEuroFilter;
  private readonly fy: OneEuroFilter;
  constructor(minCutoff?: number, beta?: number) {
    this.fx = new OneEuroFilter(minCutoff, beta);
    this.fy = new OneEuroFilter(minCutoff, beta);
  }
  reset(): void {
    this.fx.reset();
    this.fy.reset();
  }
  filter(x: number, y: number, t: number): [number, number] {
    return [this.fx.filter(x, t), this.fy.filter(y, t)];
  }
}

function alpha(dt: number, cutoff: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
