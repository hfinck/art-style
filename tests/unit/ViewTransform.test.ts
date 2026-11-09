import { describe, expect, it } from 'vitest';
import { ViewTransform } from '../../src/core/view/ViewTransform';

describe('ViewTransform', () => {
  it('fits and centres the canvas', () => {
    const v = new ViewTransform();
    v.fit(1000, 500, 400, 800, 0);
    expect(v.scale).toBeCloseTo(0.4);
    expect(v.toScreen(500, 250)).toMatchObject({ x: 200, y: 400 });
  });

  it('toCanvas inverts toScreen', () => {
    const v = new ViewTransform();
    v.scale = 1.7;
    v.rotation = 0.6;
    v.tx = 30;
    v.ty = -12;
    const s = v.toScreen(123, 456);
    const c = v.toCanvas(s.x, s.y);
    expect(c.x).toBeCloseTo(123, 6);
    expect(c.y).toBeCloseTo(456, 6);
  });

  it('two-point gesture keeps the canvas point under the fingers', () => {
    const v = new ViewTransform();
    v.fit(1000, 1000, 500, 500, 0);
    const a0 = { x: 100, y: 100 }, b0 = { x: 300, y: 100 };
    const a1 = { x: 120, y: 150 }, b1 = { x: 120, y: 550 }; // pan, zoom ×2, rotate 90°
    const ca = v.toCanvas(a0.x, a0.y);
    const cb = v.toCanvas(b0.x, b0.y);
    v.applyTwoPoint(a0, b0, a1, b1);
    const sa = v.toScreen(ca.x, ca.y);
    const sb = v.toScreen(cb.x, cb.y);
    expect(sa.x).toBeCloseTo(a1.x, 4);
    expect(sa.y).toBeCloseTo(a1.y, 4);
    expect(sb.x).toBeCloseTo(b1.x, 4);
    expect(sb.y).toBeCloseTo(b1.y, 4);
  });

  it('snaps nearly-straight rotations', () => {
    const v = new ViewTransform();
    v.rotation = 0.04;
    v.snapRotation({ x: 0, y: 0 });
    expect(v.rotation).toBe(0);
  });
});
