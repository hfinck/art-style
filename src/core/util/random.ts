import type { Random } from '../plugin-api/types';

/** Mulberry32: tiny, fast, deterministic PRNG. */
export function createRandom(seed: number): Random {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (min, max) => min + (max - min) * next(),
    int: (min, max) => min + Math.floor((max - min) * next()),
    pick: (items) => {
      if (items.length === 0) throw new Error('pick() from empty list');
      return items[Math.floor(next() * items.length)]!;
    },
  };
}

export function randomSeed(): number {
  return (Math.random() * 0xffffffff) >>> 0;
}
