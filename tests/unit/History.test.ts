import { describe, expect, it } from 'vitest';
import type { Command } from '../../src/core/engine/Command';
import { History } from '../../src/core/engine/History';

const cmd = (n: number): Command => ({ kind: 'action', action: `a${n}`, settings: {}, seed: n });
class Snap {
  disposed = false;
  constructor(readonly at: number) {}
  dispose() {
    this.disposed = true;
  }
}

describe('History', () => {
  it('plans replay from the nearest checkpoint', () => {
    const h = new History<Snap>(3, 10);
    for (let i = 0; i < 7; i++) if (h.push(cmd(i))) h.addCheckpoint(new Snap(h.cursor));
    const plan = h.plan(5);
    expect(plan.checkpoint?.at).toBe(3);
    expect(plan.replay.map((c) => (c as { action: string }).action)).toEqual(['a3', 'a4']);
  });

  it('replays from scratch without checkpoints', () => {
    const h = new History<Snap>(100, 10);
    [0, 1, 2].forEach((i) => h.push(cmd(i)));
    expect(h.plan(2)).toMatchObject({ checkpoint: null, from: 0 });
  });

  it('a new command after undo drops the redo tail and its checkpoints', () => {
    const h = new History<Snap>(2, 10);
    const snaps: Snap[] = [];
    for (let i = 0; i < 6; i++) if (h.push(cmd(i))) h.addCheckpoint(snaps[snaps.push(new Snap(h.cursor)) - 1]!);
    h.setCursor(3);
    h.push(cmd(99));
    expect(h.length).toBe(4);
    expect(h.canRedo).toBe(false);
    expect(snaps.find((s) => s.at === 4)!.disposed).toBe(true);
    expect(snaps.find((s) => s.at === 6)!.disposed).toBe(true);
    expect(snaps.find((s) => s.at === 2)!.disposed).toBe(false);
  });

  it('evicts the oldest checkpoints beyond the limit', () => {
    const h = new History<Snap>(1, 2);
    const snaps: Snap[] = [];
    for (let i = 0; i < 4; i++) if (h.push(cmd(i))) h.addCheckpoint(snaps[snaps.push(new Snap(h.cursor)) - 1]!);
    expect(snaps.filter((s) => !s.disposed).map((s) => s.at)).toEqual([3, 4]);
  });
});
