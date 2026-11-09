import type { Palette } from '@core/plugin-api';

export const PALETTES: Palette[] = [
  { id: 'sunset', name: 'Sunset', colors: ['#ff2d55', '#ff7a00', '#ffcc00', '#c2185b', '#7b1fa2'] },
  { id: 'tropic', name: 'Tropic', colors: ['#ff006e', '#fb5607', '#ffbe0b', '#3a86ff', '#8338ec', '#06d6a0'] },
  { id: 'lagoon', name: 'Lagoon', colors: ['#00b4d8', '#0057b8', '#2ec4b6', '#3a0ca3', '#7bdff2'] },
  { id: 'ember', name: 'Ember', colors: ['#9d0208', '#e01e37', '#f48c06', '#6a040f', '#ffba08'] },
  { id: 'meadow', name: 'Meadow', colors: ['#2d6a4f', '#95d5b2', '#f9c74f', '#f3722c', '#1d3557'] },
  { id: 'pastel', name: 'Pastel', colors: ['#ff8fab', '#ffc6a5', '#f6e58d', '#9be7c4', '#8ecae6', '#b8a1ff'] },
  { id: 'primary', name: 'Primary', colors: ['#e63946', '#1d4ed8', '#facc15', '#14181f', '#16a34a'] },
];

/** The white used for burying the colours (slightly warm, like titanium white). */
export const WHITE = '#fbfaf5';
/** Primed canvas colour. */
export const CANVAS = '#f2efe8';
