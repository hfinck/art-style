export interface Point {
  x: number;
  y: number;
}

/**
 * Maps canvas pixels to screen (CSS) pixels: screen = translate + rotate(scale * p).
 * Pure math, no DOM.
 */
export class ViewTransform {
  scale = 1;
  rotation = 0;
  tx = 0;
  ty = 0;

  toScreen(x: number, y: number): Point {
    const c = Math.cos(this.rotation) * this.scale;
    const s = Math.sin(this.rotation) * this.scale;
    return { x: this.tx + c * x - s * y, y: this.ty + s * x + c * y };
  }

  toCanvas(sx: number, sy: number): Point {
    const dx = sx - this.tx;
    const dy = sy - this.ty;
    const c = Math.cos(-this.rotation) / this.scale;
    const s = Math.sin(-this.rotation) / this.scale;
    return { x: c * dx - s * dy, y: s * dx + c * dy };
  }

  /** Fit a canvas of the given size centred into the viewport. */
  fit(canvasW: number, canvasH: number, viewW: number, viewH: number, margin = 12): void {
    const scale = Math.max(1e-3, Math.min((viewW - 2 * margin) / canvasW, (viewH - 2 * margin) / canvasH));
    this.scale = scale;
    this.rotation = 0;
    this.tx = (viewW - canvasW * scale) / 2;
    this.ty = (viewH - canvasH * scale) / 2;
  }

  /**
   * Apply the similarity transform that moves screen points a0→a1 and b0→b1
   * (two-finger pan, pinch-zoom and rotate).
   */
  applyTwoPoint(a0: Point, b0: Point, a1: Point, b1: Point, limits = { min: 0.05, max: 40 }): void {
    const v0x = b0.x - a0.x, v0y = b0.y - a0.y;
    const v1x = b1.x - a1.x, v1y = b1.y - a1.y;
    const l0 = Math.hypot(v0x, v0y);
    const l1 = Math.hypot(v1x, v1y);
    if (l0 < 1e-3 || l1 < 1e-3) {
      this.tx += a1.x - a0.x;
      this.ty += a1.y - a0.y;
      return;
    }
    let ds = l1 / l0;
    const newScale = Math.min(limits.max, Math.max(limits.min, this.scale * ds));
    ds = newScale / this.scale;
    const dr = Math.atan2(v1y, v1x) - Math.atan2(v0y, v0x);
    // Canvas point under a0 must end up under a1.
    const anchor = this.toCanvas(a0.x, a0.y);
    this.scale = newScale;
    this.rotation = normalizeAngle(this.rotation + dr);
    const p = this.toScreen(anchor.x, anchor.y);
    this.tx += a1.x - p.x;
    this.ty += a1.y - p.y;
  }

  /** Zoom by `factor` around a screen point (mouse wheel). */
  zoomAt(sx: number, sy: number, factor: number, limits = { min: 0.05, max: 40 }): void {
    const anchor = this.toCanvas(sx, sy);
    this.scale = Math.min(limits.max, Math.max(limits.min, this.scale * factor));
    const p = this.toScreen(anchor.x, anchor.y);
    this.tx += sx - p.x;
    this.ty += sy - p.y;
  }

  /** If rotation is within `threshold` radians of a multiple of 90°, snap to it (keeping `pivot` fixed). */
  snapRotation(pivot: Point, threshold = (5 * Math.PI) / 180): void {
    const quarter = Math.PI / 2;
    const target = Math.round(this.rotation / quarter) * quarter;
    if (Math.abs(target - this.rotation) > threshold || target === this.rotation) return;
    const anchor = this.toCanvas(pivot.x, pivot.y);
    this.rotation = normalizeAngle(target);
    const p = this.toScreen(anchor.x, anchor.y);
    this.tx += pivot.x - p.x;
    this.ty += pivot.y - p.y;
  }

  /** Column-major 3×3 matrix mapping canvas px to clip space for a viewport in device px. */
  clipMatrix(viewW: number, viewH: number, dpr: number): Float32Array {
    const c = Math.cos(this.rotation) * this.scale * dpr;
    const s = Math.sin(this.rotation) * this.scale * dpr;
    const tx = this.tx * dpr;
    const ty = this.ty * dpr;
    const sx = 2 / viewW;
    const sy = -2 / viewH;
    return new Float32Array([c * sx, s * sy, 0, -s * sx, c * sy, 0, tx * sx - 1, ty * sy + 1, 1]);
  }
}

function normalizeAngle(a: number): number {
  const t = Math.PI * 2;
  return ((((a + Math.PI) % t) + t) % t) - Math.PI;
}
