import type { StyleEntry } from '../core/engine/PluginRegistry';

/**
 * The installed styles. Adding a style = add a folder under src/styles/ and one line here.
 * Each entry is a lazy import, so a style's code is only downloaded when it is used.
 */
export const STYLE_ENTRIES: StyleEntry[] = [
  { id: 'voinea-sweep', load: () => import('../styles/voinea-sweep') },
];
