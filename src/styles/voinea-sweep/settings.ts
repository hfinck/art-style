import type { SettingDef } from '@core/plugin-api';

const color: SettingDef = { type: 'color', id: 'color', label: 'Colour' };

export const DROP_SETTINGS: SettingDef[] = [
  color,
  { type: 'range', id: 'size', label: 'Blob size', min: 2, max: 30, default: 9, unit: '%' },
  { type: 'range', id: 'thickness', label: 'Thickness', min: 10, max: 100, default: 55, unit: '%' },
  { type: 'range', id: 'variation', label: 'Size variation', min: 0, max: 100, default: 35, unit: '%' },
];

export const SCATTER_SETTINGS: SettingDef[] = [
  color,
  { type: 'range', id: 'count', label: 'Blobs', min: 3, max: 40, default: 14 },
  { type: 'range', id: 'size', label: 'Blob size', min: 2, max: 30, default: 8, unit: '%' },
  { type: 'range', id: 'thickness', label: 'Thickness', min: 10, max: 100, default: 55, unit: '%' },
];

export const POUR_SETTINGS: SettingDef[] = [
  { type: 'range', id: 'size', label: 'Pour width', min: 5, max: 60, default: 22, unit: '%' },
  { type: 'range', id: 'thickness', label: 'White thickness', min: 10, max: 100, default: 60, unit: '%' },
];

export const COVER_SETTINGS: SettingDef[] = [
  { type: 'range', id: 'thickness', label: 'White thickness', min: 10, max: 100, default: 60, unit: '%' },
];

function sweepSettings(width: number): SettingDef[] {
  return [
    { type: 'range', id: 'width', label: 'Brush width', min: 3, max: 90, default: width, unit: '%' },
    { type: 'range', id: 'depth', label: 'Depth (reveal colour)', min: 0, max: 100, default: 60, unit: '%' },
    { type: 'range', id: 'smear', label: 'Smear length', min: 2, max: 100, default: 35, unit: '%' },
    { type: 'range', id: 'coverage', label: 'Paint coverage', min: 10, max: 100, default: 85, unit: '%' },
    { type: 'range', id: 'streaks', label: 'Bristle streaks', min: 0, max: 100, default: 55, unit: '%' },
    { type: 'range', id: 'ridges', label: 'Edge ridges', min: 0, max: 100, default: 45, unit: '%' },
  ];
}

export const BROAD_SETTINGS = sweepSettings(38);
export const DETAIL_SETTINGS = sweepSettings(10);
