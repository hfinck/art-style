import { describe, expect, it } from 'vitest';
import { GestureRecognizer, type GestureHandlers } from '../../src/core/input/GestureRecognizer';

function setup() {
  const log: string[] = [];
  const h: GestureHandlers = {
    strokeStart: () => log.push('start'),
    strokeMove: (p) => log.push(`move${p.length}`),
    strokeEnd: () => log.push('end'),
    strokeCancel: () => log.push('cancel'),
    viewChange: () => log.push('view'),
    tap: (n) => log.push(`tap${n}`),
    gestureEnd: () => log.push('gestureEnd'),
  };
  return { g: new GestureRecognizer(h), log };
}

const pt = (x: number, y: number, t: number) => ({ x, y, t });

describe('GestureRecognizer', () => {
  it('turns a single-finger drag into a stroke', () => {
    const { g, log } = setup();
    g.down(1, pt(0, 0, 0));
    g.move(1, [pt(5, 0, 8)]);
    expect(log).toEqual([]); // still pending: could become a two-finger gesture
    g.move(1, [pt(20, 0, 16)]);
    g.move(1, [pt(30, 0, 24), pt(35, 0, 26)]);
    g.up(1, 30);
    expect(log).toEqual(['start', 'move2', 'move2', 'end']);
  });

  it('starts painting after the hold time even without movement', () => {
    const { g, log } = setup();
    g.down(1, pt(0, 0, 0));
    g.move(1, [pt(1, 0, 100)]);
    expect(log[0]).toBe('start');
  });

  it('a quick tap is a short stroke (e.g. dropping a blob)', () => {
    const { g, log } = setup();
    g.down(1, pt(0, 0, 0));
    g.up(1, 40);
    expect(log).toEqual(['start', 'end']);
  });

  it('a second finger during the pending phase navigates without painting', () => {
    const { g, log } = setup();
    g.down(1, pt(0, 0, 0));
    g.down(2, pt(100, 0, 20));
    g.move(2, [pt(150, 0, 40)]);
    g.up(1, 60);
    g.up(2, 70);
    expect(log).not.toContain('start');
    expect(log).toContain('view');
  });

  it('a second finger after painting started cancels the stroke', () => {
    const { g, log } = setup();
    g.down(1, pt(0, 0, 0));
    g.move(1, [pt(50, 0, 20)]);
    g.down(2, pt(100, 100, 120));
    g.up(1, 130);
    g.up(2, 140);
    expect(log).toContain('cancel');
    expect(log).not.toContain('tap2'); // must not also undo the previous stroke
  });

  it('two-finger tap = tap(2), three-finger tap = tap(3)', () => {
    const a = setup();
    a.g.down(1, pt(0, 0, 0));
    a.g.down(2, pt(50, 0, 15));
    a.g.up(1, 120);
    a.g.up(2, 130);
    expect(a.log).toContain('tap2');

    const b = setup();
    b.g.down(1, pt(0, 0, 0));
    b.g.down(2, pt(50, 0, 10));
    b.g.down(3, pt(100, 0, 20));
    b.g.up(1, 150);
    b.g.up(2, 155);
    b.g.up(3, 160);
    expect(b.log).toContain('tap3');
  });

  it('a long two-finger pinch is not a tap', () => {
    const { g, log } = setup();
    g.down(1, pt(0, 0, 0));
    g.down(2, pt(50, 0, 10));
    g.move(2, [pt(150, 0, 200)]);
    g.up(1, 400);
    g.up(2, 410);
    expect(log).not.toContain('tap2');
  });

  it('pointercancel ends an active stroke cleanly', () => {
    const { g, log } = setup();
    g.down(1, pt(0, 0, 0));
    g.move(1, [pt(50, 0, 20)]);
    g.cancel(1);
    expect(log.at(-1)).toBe('end');
    expect(g.isPainting).toBe(false);
  });

  it('mouse paints immediately; right button pans', () => {
    const { g, log } = setup();
    g.down(1, pt(0, 0, 0), 'mouse', 0);
    expect(log).toEqual(['start']);
    g.up(1, 10);
    g.down(1, pt(0, 0, 20), 'mouse', 2);
    g.move(1, [pt(10, 0, 30)]);
    expect(log).toContain('view');
  });

  it('a finger held still starts painting via poll() after the hold time', () => {
    const { g, log } = setup();
    g.down(1, pt(0, 0, 0));
    g.poll(30);
    expect(log).toEqual([]);
    g.poll(80);
    expect(log).toEqual(['start']);
    expect(g.isPainting).toBe(true);
    g.up(1, 900);
    expect(log).toEqual(['start', 'end']);
  });
});
