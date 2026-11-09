import { describe, expect, it } from 'vitest';
import type { Stamp } from '../../src/core/plugin-api/types';
import { StrokeResampler } from '../../src/core/input/StrokeResampler';

function run(points: [number, number][], spacing = 2, smoothing = 0, chunks = 1): Stamp[] {
  const out: Stamp[] = [];
  const r = new StrokeResampler(spacing, smoothing, (s) => out.push(s));
  const size = Math.ceil(points.length / chunks);
  for (let i = 0; i < points.length; i += size) points.slice(i, i + size).forEach(([x, y]) => r.add(x, y));
  r.finish();
  return out;
}

describe('StrokeResampler', () => {
  it('emits evenly spaced stamps along a straight line', () => {
    const stamps = run([[0, 0], [50, 0], [100, 0]], 2);
    expect(stamps.length).toBeGreaterThan(45);
    for (let i = 1; i < stamps.length; i++) {
      expect(stamps[i]!.x - stamps[i - 1]!.x).toBeCloseTo(2, 3);
      expect(stamps[i]!.y).toBeCloseTo(0, 6);
      expect(stamps[i]!.dirX).toBeCloseTo(1, 6);
    }
  });

  it('links each stamp to the previous one', () => {
    const stamps = run([[0, 0], [10, 10], [30, 5], [60, 40]], 1.5, 10);
    stamps.forEach((s, i) => {
      expect(s.index).toBe(i);
      if (i > 0) {
        expect(s.prevX).toBe(stamps[i - 1]!.x);
        expect(s.prevDirX).toBe(stamps[i - 1]!.dirX);
      }
    });
  });

  it('emits a single stamp for a tap', () => {
    const stamps = run([[5, 5]]);
    expect(stamps).toHaveLength(1);
    expect(stamps[0]).toMatchObject({ x: 5, y: 5, dirX: 1, dirY: 0 });
  });

  it('is deterministic regardless of how input is chunked (undo replay relies on this)', () => {
    const pts: [number, number][] = Array.from({ length: 60 }, (_, i) => [i * 3.3, Math.sin(i / 5) * 40]);
    expect(run(pts, 2, 20, 1)).toEqual(run(pts, 2, 20, 7));
  });

  it('smooths direction changes', () => {
    const sharp = run([[0, 0], [100, 0], [100, 100]], 2, 0);
    const smooth = run([[0, 0], [100, 0], [100, 100]], 2, 60);
    const maxTurn = (st: Stamp[]) =>
      Math.max(...st.slice(1).map((s) => Math.acos(Math.min(1, s.dirX * s.prevDirX + s.dirY * s.prevDirY))));
    expect(maxTurn(smooth)).toBeLessThan(maxTurn(sharp));
  });

  it('interpolates time along the path', () => {
    const out: Stamp[] = [];
    const r = new StrokeResampler(2, 0, (s) => out.push(s));
    r.add(0, 0, 0);
    r.add(50, 0, 100);
    r.add(100, 0, 200);
    r.finish();
    const mid = out.find((s) => Math.abs(s.x - 50) < 1)!;
    expect(mid.time).toBeGreaterThan(90);
    expect(mid.time).toBeLessThan(110);
    for (let i = 1; i < out.length; i++) expect(out[i]!.time).toBeGreaterThanOrEqual(out[i - 1]!.time);
  });

  it('emits the first stamp immediately when the tool does not smooth direction (press and hold)', () => {
    const out: Stamp[] = [];
    const r = new StrokeResampler(2, 0, (s) => out.push(s));
    r.add(10, 10, 0);
    expect(out).toHaveLength(1);
    const smoothed: Stamp[] = [];
    const r2 = new StrokeResampler(2, 20, (s) => smoothed.push(s));
    r2.add(10, 10, 0);
    expect(smoothed).toHaveLength(0); // waits for a direction
  });
});
