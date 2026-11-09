import { batch, computed, signal } from '@preact/signals';
import type {
  ActionDefinition,
  ColorChoice,
  PhaseDefinition,
  SettingDef,
  SettingValues,
  StylePlugin,
  ToolDefinition,
} from '@core/plugin-api';
import { Engine } from '../core/engine/Engine';
import type { ProjectData } from '../core/engine/Command';
import { FORMATS, formatById } from '../core/engine/formats';
import { PluginRegistry } from '../core/engine/PluginRegistry';
import { openProjectStore, type ProjectStore, type ProjectSummary } from '../core/storage/ProjectStore';
import { imageToPng, imageToThumbnail, shareOrDownload } from '../core/storage/Exporter';
import { STYLE_ENTRIES } from '../app/styles';

export type Sheet = 'none' | 'settings' | 'new' | 'gallery' | 'palettes';

interface StoredPrefs {
  settings: Record<string, SettingValues>;
  paletteId?: string;
  colorIndex?: number; // -1 = random from palette
}

const LAST_PROJECT_KEY = 'art-style:last-project';
const prefsKey = (styleId: string) => `art-style:prefs:${styleId}`;

function defaultsFor(defs: SettingDef[]): SettingValues {
  const v: SettingValues = {};
  for (const d of defs) {
    if (d.type === 'range') v[d.id] = d.default;
    else if (d.type === 'toggle') v[d.id] = d.default;
  }
  return v;
}

function readPrefs(styleId: string): StoredPrefs {
  try {
    const raw = localStorage.getItem(prefsKey(styleId));
    if (raw) return JSON.parse(raw) as StoredPrefs;
  } catch {
    /* ignore */
  }
  return { settings: {} };
}

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * Application controller: connects the engine, the plugin registry and storage to
 * UI state (signals). Components only read signals and call methods here.
 */
export class AppController {
  readonly registry = new PluginRegistry(STYLE_ENTRIES);
  readonly plugin = signal<StylePlugin | null>(null);
  readonly styles = signal<StylePlugin[]>([]);
  readonly phaseIndex = signal(0);
  readonly toolByPhase = signal<Record<string, string>>({});
  readonly settings = signal<Record<string, SettingValues>>({});
  readonly paletteId = signal('');
  /** Index into the palette, or -1 for "random from palette". */
  readonly colorIndex = signal(-1);
  readonly canUndo = signal(false);
  readonly canRedo = signal(false);
  readonly busy = signal(false);
  readonly progress = signal(0);
  readonly sheet = signal<Sheet>('none');
  readonly hint = signal<string | null>(null);
  readonly error = signal<string | null>(null);
  readonly project = signal<ProjectData | null>(null);
  readonly gallery = signal<ProjectSummary[]>([]);
  readonly ready = signal(false);

  readonly phase = computed<PhaseDefinition | null>(() => this.plugin.value?.phases[this.phaseIndex.value] ?? null);
  readonly tool = computed<ToolDefinition | null>(() => {
    const p = this.plugin.value;
    const ph = this.phase.value;
    if (!p || !ph) return null;
    const id = this.toolByPhase.value[ph.id] ?? ph.tools[0];
    return p.tools.find((t) => t.id === id) ?? null;
  });
  readonly phaseActions = computed<ActionDefinition[]>(() => {
    const p = this.plugin.value;
    const ph = this.phase.value;
    if (!p || !ph) return [];
    return ph.actions.map((id) => p.actions.find((a) => a.id === id)!).filter(Boolean);
  });
  readonly palette = computed(() => {
    const p = this.plugin.value;
    return p?.palettes.find((x) => x.id === this.paletteId.value) ?? p?.palettes[0] ?? null;
  });
  /** Whether the current phase uses colours (shows the palette bar). */
  readonly usesColor = computed(() => {
    const t = this.tool.value;
    const defs = [...(t?.settings ?? []), ...this.phaseActions.value.flatMap((a) => a.settings)];
    return defs.some((d) => d.type === 'color');
  });

  engine: Engine | null = null;
  private store: ProjectStore | null = null;
  private saveTimer = 0;
  private hintTimer = 0;
  private lastSavedRevision = 0;
  private revision = 0;

  async attach(canvas: HTMLCanvasElement): Promise<void> {
    try {
      this.engine = new Engine(canvas, {
        getTool: () => this.currentTool(),
        onHistory: (h) => {
          batch(() => {
            this.canUndo.value = h.canUndo;
            this.canRedo.value = h.canRedo;
          });
          this.revision = h.revision;
          this.scheduleSave();
        },
        onBusy: (busy, progress) => {
          batch(() => {
            this.busy.value = busy;
            this.progress.value = progress;
          });
        },
        onError: (e) => this.fail(e),
      });
    } catch (e) {
      this.fail(e as Error);
      return;
    }
    this.store = await openProjectStore();
    const ids = this.registry.ids();
    this.styles.value = await Promise.all(ids.map((id) => this.registry.load(id)));
    await this.refreshGallery();

    const lastId = safeGet(LAST_PROJECT_KEY);
    const last = lastId ? await this.store.get(lastId) : undefined;
    if (last && this.registry.has(last.styleId)) {
      await this.openProject(last);
    } else {
      await this.newPainting(ids[0]!, FORMATS[0]!.id, false);
      this.sheet.value = 'new';
    }
    this.ready.value = true;

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void this.saveNow();
    });
  }

  private fail(e: Error): void {
    console.error(e);
    this.error.value = e.message;
  }

  // ---------------------------------------------------------------------------
  // Projects
  // ---------------------------------------------------------------------------

  private async usePlugin(styleId: string): Promise<StylePlugin> {
    const plugin = await this.registry.load(styleId);
    const prefs = readPrefs(styleId);
    const settings: Record<string, SettingValues> = {};
    for (const def of [...plugin.tools, ...plugin.actions]) {
      settings[def.id] = { ...defaultsFor(def.settings), ...(prefs.settings[def.id] ?? {}) };
    }
    batch(() => {
      this.plugin.value = plugin;
      this.settings.value = settings;
      this.paletteId.value = plugin.palettes.some((p) => p.id === prefs.paletteId) ? prefs.paletteId! : (plugin.palettes[0]?.id ?? '');
      this.colorIndex.value = prefs.colorIndex ?? -1;
      this.toolByPhase.value = {};
    });
    return plugin;
  }

  async newPainting(styleId: string, formatId: string, closeSheet = true): Promise<void> {
    await this.saveNow();
    const plugin = await this.usePlugin(styleId);
    const now = Date.now();
    const project: ProjectData = {
      id: uid(),
      name: `Painting ${new Date(now).toLocaleDateString()}`,
      styleId,
      formatId,
      createdAt: now,
      updatedAt: now,
      commands: [],
    };
    this.project.value = project;
    this.lastSavedRevision = this.revision;
    await this.engine!.open(plugin, formatById(formatId).ratio);
    this.selectPhase(0, closeSheet);
    if (closeSheet) this.sheet.value = 'none';
  }

  async openProject(idOrData: string | ProjectData): Promise<void> {
    await this.saveNow();
    const data = typeof idOrData === 'string' ? await this.store!.get(idOrData) : idOrData;
    if (!data) return;
    const plugin = await this.usePlugin(data.styleId);
    this.project.value = data;
    this.sheet.value = 'none';
    safeSet(LAST_PROJECT_KEY, data.id);
    await this.engine!.open(plugin, formatById(data.formatId).ratio, data.commands);
    this.lastSavedRevision = this.revision;
    // Continue where the painting stands: sweep if there is paint, otherwise start.
    this.selectPhase(data.commands.length > 0 ? plugin.phases.length - 1 : 0, false);
  }

  async deleteProject(id: string): Promise<void> {
    await this.store?.delete(id);
    if (this.project.value?.id === id) {
      this.project.value = null;
      safeSet(LAST_PROJECT_KEY, '');
      await this.newPainting(this.plugin.value?.manifest.id ?? this.registry.ids()[0]!, FORMATS[0]!.id, false);
    }
    await this.refreshGallery();
  }

  async refreshGallery(): Promise<void> {
    if (this.store) this.gallery.value = await this.store.list();
  }

  private scheduleSave(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.saveNow(), 1200);
  }

  async saveNow(): Promise<void> {
    clearTimeout(this.saveTimer);
    const engine = this.engine;
    const project = this.project.value;
    if (!engine || !project || !this.store || engine.isBusy) return;
    if (this.revision === this.lastSavedRevision) return;
    const commands = engine.commands();
    if (commands.length === 0 && project.commands.length === 0) return;
    this.lastSavedRevision = this.revision;
    const updated: ProjectData = { ...project, commands, updatedAt: Date.now() };
    this.project.value = updated;
    let thumb: Blob | undefined;
    try {
      thumb = await imageToThumbnail(engine.readImage());
    } catch (e) {
      console.warn('Thumbnail failed', e);
    }
    await this.store.save(updated, thumb);
    safeSet(LAST_PROJECT_KEY, updated.id);
    await this.refreshGallery();
  }

  // ---------------------------------------------------------------------------
  // Tools, phases, settings
  // ---------------------------------------------------------------------------

  selectPhase(index: number, showHint = true): void {
    const p = this.plugin.value;
    if (!p) return;
    this.phaseIndex.value = Math.max(0, Math.min(p.phases.length - 1, index));
    if (showHint) this.showHint(p.phases[this.phaseIndex.value]!.hint);
    navigator.vibrate?.(8);
  }

  selectTool(toolId: string): void {
    const ph = this.phase.value;
    if (!ph) return;
    this.toolByPhase.value = { ...this.toolByPhase.value, [ph.id]: toolId };
  }

  showHint(text: string): void {
    clearTimeout(this.hintTimer);
    this.hint.value = text;
    this.hintTimer = window.setTimeout(() => (this.hint.value = null), 3800);
  }

  setSetting(ownerId: string, settingId: string, value: number | boolean): void {
    this.settings.value = {
      ...this.settings.value,
      [ownerId]: { ...this.settings.value[ownerId], [settingId]: value },
    };
    this.persistPrefs();
  }

  resetSettings(ownerId: string): void {
    const p = this.plugin.value;
    const def = p && [...p.tools, ...p.actions].find((d) => d.id === ownerId);
    if (!def) return;
    this.settings.value = { ...this.settings.value, [ownerId]: defaultsFor(def.settings) };
    this.persistPrefs();
  }

  selectColor(index: number): void {
    this.colorIndex.value = index;
    this.persistPrefs();
  }

  selectPalette(id: string): void {
    batch(() => {
      this.paletteId.value = id;
      this.colorIndex.value = -1;
    });
    this.persistPrefs();
  }

  private persistPrefs(): void {
    const p = this.plugin.value;
    if (!p) return;
    const prefs: StoredPrefs = {
      settings: this.settings.value,
      paletteId: this.paletteId.value,
      colorIndex: this.colorIndex.value,
    };
    safeSet(prefsKey(p.manifest.id), JSON.stringify(prefs));
  }

  private colorChoice(): ColorChoice {
    const colors = this.palette.value?.colors ?? ['#ff2d55'];
    const i = this.colorIndex.value;
    return i >= 0 && i < colors.length ? { mode: 'fixed', colors: [colors[i]!] } : { mode: 'random', colors: [...colors] };
  }

  /** Settings with colour choices filled in, ready to be stored in a command. */
  private resolved(defs: SettingDef[], values: SettingValues | undefined): SettingValues {
    const out: SettingValues = { ...defaultsFor(defs), ...(values ?? {}) };
    for (const d of defs) if (d.type === 'color') out[d.id] = this.colorChoice();
    return out;
  }

  private currentTool() {
    const t = this.tool.value;
    if (!t || this.sheet.value !== 'none') return null;
    return { toolId: t.id, settings: this.resolved(t.settings, this.settings.value[t.id]) };
  }

  runAction(actionId: string): void {
    const a = this.plugin.value?.actions.find((x) => x.id === actionId);
    if (!a || !this.engine) return;
    this.engine.runAction(a.id, this.resolved(a.settings, this.settings.value[a.id]));
    navigator.vibrate?.(10);
  }

  undo(): void {
    void this.engine?.undo();
  }

  redo(): void {
    void this.engine?.redo();
  }

  clear(): void {
    this.engine?.clearAll();
    this.selectPhase(0);
  }

  fit(): void {
    this.engine?.fitView();
  }

  async exportImage(): Promise<void> {
    const engine = this.engine;
    if (!engine) return;
    try {
      const blob = await imageToPng(engine.readImage());
      const name = `${(this.project.value?.name ?? 'painting').replace(/[^\w-]+/g, '-')}.png`;
      const how = await shareOrDownload(blob, name);
      if (how === 'downloaded') this.showHint('Image saved to your downloads.');
    } catch (e) {
      this.fail(e as Error);
    }
  }
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage may be unavailable */
  }
}
