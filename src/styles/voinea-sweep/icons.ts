import type { IconPath } from '@core/plugin-api';

/** Icons are stroked 24×24 paths. */
const circle = (cx: number, cy: number, r: number) =>
  `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;

export const ICONS = {
  drop: 'M12 3c-3.6 4.6-6 7.9-6 11a6 6 0 0 0 12 0c0-3.1-2.4-6.4-6-11z',
  scatter: [circle(6.5, 7, 2.5), circle(16.5, 6.5, 3), circle(9, 16.5, 3.5), circle(18, 17, 2)].join(''),
  pour: 'M6 4h12l-1.6 13.2a3 3 0 0 1-3 2.8h-2.8a3 3 0 0 1-3-2.8zM6.6 9h10.8',
  cover: 'M12 3l9 4.5-9 4.5-9-4.5zM3 12l9 4.5 9-4.5M3 16.5l9 4.5 9-4.5',
  layers: 'M12 3l9 4.5-9 4.5-9-4.5zM3 12l9 4.5 9-4.5',
  broad: 'M3 13h18v3.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5zM6 13V5h12v8M9 5v8M12 5v8M15 5v8',
  detail: 'M8 13h8v4a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2zM9.5 13V4h5v9',
  sweep: 'M3 8c3-3 6 3 9 0s6-3 9 0M3 13c3-3 6 3 9 0s6-3 9 0M3 18c3-3 6 3 9 0s6-3 9 0',
} satisfies Record<string, IconPath>;
