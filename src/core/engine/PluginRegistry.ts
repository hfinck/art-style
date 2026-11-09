import { PLUGIN_API_VERSION, type StylePlugin } from '../plugin-api/types';

export interface StyleEntry {
  id: string;
  /** Lazy loader so every style becomes its own code-split chunk. */
  load: () => Promise<{ default: StylePlugin }>;
}

export class PluginRegistry {
  private readonly entries = new Map<string, StyleEntry>();
  private readonly loaded = new Map<string, Promise<StylePlugin>>();

  constructor(entries: readonly StyleEntry[] = []) {
    entries.forEach((e) => this.register(e));
  }

  register(entry: StyleEntry): void {
    if (this.entries.has(entry.id)) throw new Error(`Style "${entry.id}" registered twice`);
    this.entries.set(entry.id, entry);
  }

  ids(): string[] {
    return [...this.entries.keys()];
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  load(id: string): Promise<StylePlugin> {
    const cached = this.loaded.get(id);
    if (cached) return cached;
    const entry = this.entries.get(id);
    if (!entry) return Promise.reject(new Error(`Unknown style "${id}"`));
    const p = entry.load().then(({ default: plugin }) => {
      validatePlugin(plugin, id);
      return plugin;
    });
    this.loaded.set(id, p);
    p.catch(() => this.loaded.delete(id));
    return p;
  }
}

export function validatePlugin(plugin: StylePlugin, expectedId: string): void {
  const m = plugin.manifest;
  if (m.apiVersion !== PLUGIN_API_VERSION) {
    throw new Error(`Style "${m.id}" targets plugin API v${m.apiVersion}, app provides v${PLUGIN_API_VERSION}`);
  }
  if (m.id !== expectedId) throw new Error(`Style id mismatch: registered "${expectedId}", manifest "${m.id}"`);
  const tools = new Set(plugin.tools.map((t) => t.id));
  const actions = new Set(plugin.actions.map((a) => a.id));
  if (plugin.phases.length === 0) throw new Error(`Style "${m.id}" has no phases`);
  for (const phase of plugin.phases) {
    for (const t of phase.tools) if (!tools.has(t)) throw new Error(`Phase "${phase.id}" references unknown tool "${t}"`);
    for (const a of phase.actions) if (!actions.has(a)) throw new Error(`Phase "${phase.id}" references unknown action "${a}"`);
  }
}
