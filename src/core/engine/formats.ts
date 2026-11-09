export interface CanvasFormat {
  id: string;
  label: string;
  /** Width / height. */
  ratio: number;
}

export const FORMATS: readonly CanvasFormat[] = [
  { id: '1:1', label: 'Square', ratio: 1 },
  { id: '4:5', label: 'Portrait 4:5', ratio: 4 / 5 },
  { id: '2:3', label: 'Portrait 2:3', ratio: 2 / 3 },
  { id: '9:16', label: 'Phone 9:16', ratio: 9 / 16 },
  { id: '3:2', label: 'Landscape 3:2', ratio: 3 / 2 },
  { id: '16:9', label: 'Wide 16:9', ratio: 16 / 9 },
];

export function formatById(id: string): CanvasFormat {
  return FORMATS.find((f) => f.id === id) ?? FORMATS[0]!;
}

/**
 * Simulation size for a format: as many pixels as the device budget allows,
 * rounded to multiples of 8 and limited by the max texture size.
 */
export function simulationSize(ratio: number, pixelBudget: number, maxTexture: number): { width: number; height: number } {
  let w = Math.sqrt(pixelBudget * ratio);
  let h = w / ratio;
  const limit = Math.min(maxTexture, 4096);
  const over = Math.max(w / limit, h / limit, 1);
  w /= over;
  h /= over;
  const r8 = (v: number) => Math.max(8, Math.floor(v / 8) * 8);
  return { width: r8(w), height: r8(h) };
}
