import { PLUGIN_API_VERSION, type StylePlugin } from '@core/plugin-api';
import { ICONS } from './icons';
import { PALETTES } from './palettes';
import {
  BROAD_SETTINGS,
  COVER_SETTINGS,
  DETAIL_SETTINGS,
  DROP_SETTINGS,
  POUR_SETTINGS,
  SCATTER_SETTINGS,
} from './settings';
import { SweepSession } from './SweepSession';

/**
 * Colour Sweep — inspired by the technique of Alex Voinea:
 * splodges of colour, buried under white, then revealed with broad, connected strokes.
 */
const plugin: StylePlugin = {
  manifest: {
    id: 'voinea-sweep',
    name: 'Colour Sweep',
    description: 'Drop colour, bury it in white, then drag it back out with broad, bold strokes.',
    credit: 'Inspired by the technique of Alex Voinea',
    apiVersion: PLUGIN_API_VERSION,
  },
  phases: [
    {
      id: 'splodge',
      label: 'Splodge',
      icon: ICONS.drop,
      hint: 'Tap to drop blobs of colour, drag for a trail — or scatter them.',
      tools: ['drop'],
      actions: ['scatter'],
    },
    {
      id: 'bury',
      label: 'Bury',
      icon: ICONS.layers,
      hint: 'Pour white over the colours. Cover everything or just parts.',
      tools: ['pour'],
      actions: ['cover'],
    },
    {
      id: 'sweep',
      label: 'Sweep',
      icon: ICONS.sweep,
      hint: 'Drag the broad brush through the paint in long, connected strokes.',
      tools: ['broad', 'detail'],
      actions: [],
    },
  ],
  tools: [
    { id: 'drop', label: 'Drop', icon: ICONS.drop, settings: DROP_SETTINGS },
    { id: 'pour', label: 'Pour', icon: ICONS.pour, settings: POUR_SETTINGS },
    { id: 'broad', label: 'Broad brush', icon: ICONS.broad, settings: BROAD_SETTINGS },
    { id: 'detail', label: 'Small brush', icon: ICONS.detail, settings: DETAIL_SETTINGS },
  ],
  actions: [
    { id: 'scatter', label: 'Scatter', icon: ICONS.scatter, settings: SCATTER_SETTINGS },
    { id: 'cover', label: 'Cover all', icon: ICONS.cover, settings: COVER_SETTINGS },
  ],
  palettes: PALETTES,
  createSession: (ctx) => new SweepSession(ctx),
};

export default plugin;
