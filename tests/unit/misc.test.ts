import { describe, expect, it } from 'vitest';
import { simulationSize, FORMATS } from '../../src/core/engine/formats';
import { PluginRegistry, validatePlugin } from '../../src/core/engine/PluginRegistry';
import { createRandom } from '../../src/core/util/random';
import { hexToRgb } from '../../src/core/util/color';
import { PLUGIN_API_VERSION, type StylePlugin } from '../../src/core/plugin-api/types';
import sweep from '../../src/styles/voinea-sweep';

describe('formats', () => {
  it('respects the pixel budget and aspect ratio', () => {
    for (const f of FORMATS) {
      const { width, height } = simulationSize(f.ratio, 2_000_000, 4096);
      expect(width * height).toBeLessThanOrEqual(2_000_000);
      expect(width * height).toBeGreaterThan(1_800_000);
      expect(Math.abs(width / height - f.ratio)).toBeLessThan(0.02);
      expect(width % 8).toBe(0);
    }
  });
  it('stays within the max texture size', () => {
    const s = simulationSize(16 / 9, 4_000_000, 1024);
    expect(Math.max(s.width, s.height)).toBeLessThanOrEqual(1024);
  });
});

describe('random', () => {
  it('is deterministic per seed', () => {
    const a = createRandom(42), b = createRandom(42);
    expect([a.next(), a.next(), a.next()]).toEqual([b.next(), b.next(), b.next()]);
  });
});

describe('color', () => {
  it('parses hex', () => {
    expect(hexToRgb('#ff0000')).toEqual([1, 0, 0]);
    expect(hexToRgb('0f0')).toEqual([0, 1, 0]);
    expect(() => hexToRgb('nope')).toThrow();
  });
});

describe('plugins', () => {
  it('the Colour Sweep plugin satisfies the contract', () => {
    expect(() => validatePlugin(sweep, 'voinea-sweep')).not.toThrow();
  });

  it('rejects incompatible API versions and broken phases', () => {
    const bad = { ...sweep, manifest: { ...sweep.manifest, apiVersion: 99 } } as unknown as StylePlugin;
    expect(() => validatePlugin(bad, 'voinea-sweep')).toThrow(/API/);
    const broken: StylePlugin = { ...sweep, phases: [{ ...sweep.phases[0]!, tools: ['missing'] }] };
    expect(() => validatePlugin(broken, 'voinea-sweep')).toThrow(/unknown tool/);
    expect(sweep.manifest.apiVersion).toBe(PLUGIN_API_VERSION);
  });

  it('registry loads lazily and caches', async () => {
    let loads = 0;
    const reg = new PluginRegistry([{ id: 'voinea-sweep', load: async () => (loads++, { default: sweep }) }]);
    await reg.load('voinea-sweep');
    await reg.load('voinea-sweep');
    expect(loads).toBe(1);
    await expect(reg.load('nope')).rejects.toThrow();
  });
});
