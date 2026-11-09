/**
 * Public contract between the core application and style plugins.
 *
 * Style plugins may ONLY import from `@core/plugin-api`. Everything a plugin needs at
 * runtime (GPU access, canvas size, dirty tracking, randomness) is handed to it through
 * the objects described here. The core never imports a plugin directly; plugins are
 * registered as lazy imports in `src/app/styles.ts`.
 */

export const PLUGIN_API_VERSION = 1;

// ---------------------------------------------------------------------------
// Manifest, phases, tools and settings
// ---------------------------------------------------------------------------

export interface StyleManifest {
  /** Stable identifier, stored in saved projects. */
  id: string;
  name: string;
  /** One-line description shown in the style picker. */
  description: string;
  /** Short credit line, e.g. "Inspired by the technique of …". */
  credit?: string;
  apiVersion: typeof PLUGIN_API_VERSION;
}

/** An SVG path (`d` attribute) drawn in a 24×24 viewBox with `currentColor`. */
export type IconPath = string;

/** A guided step of the style's workflow. */
export interface PhaseDefinition {
  id: string;
  label: string;
  icon: IconPath;
  /** Short instruction shown when the phase becomes active. */
  hint: string;
  /** Stroke tools offered in this phase (first one is selected by default). */
  tools: string[];
  /** One-shot actions offered in this phase. */
  actions: string[];
}

export type SettingDef =
  | {
      type: 'range';
      id: string;
      label: string;
      min: number;
      max: number;
      step?: number;
      default: number;
      /** Optional unit suffix shown in the UI, e.g. "%". */
      unit?: string;
    }
  | { type: 'toggle'; id: string; label: string; default: boolean }
  /** A colour choice; the core UI shows the palette bar and fills in the value. */
  | { type: 'color'; id: string; label: string };

/** Colour choice handed to the plugin for `color` settings. */
export interface ColorChoice {
  /** 'fixed' uses colors[0]; 'random' picks from colors using the command's RNG. */
  mode: 'fixed' | 'random';
  /** Hex colours, e.g. "#ff3366". */
  colors: string[];
}

export type SettingValue = number | boolean | ColorChoice;
export type SettingValues = Record<string, SettingValue>;

export interface ToolDefinition {
  id: string;
  label: string;
  icon: IconPath;
  settings: SettingDef[];
}

export interface ActionDefinition {
  id: string;
  label: string;
  icon: IconPath;
  settings: SettingDef[];
}

export interface Palette {
  id: string;
  name: string;
  colors: string[];
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Deterministic random source. Replaying a command with the same seed gives the same result. */
export interface Random {
  /** Uniform in [0, 1). */
  next(): number;
  range(min: number, max: number): number;
  int(minInclusive: number, maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
}

/**
 * One evenly spaced sample along a smoothed stroke, in simulation pixels
 * (origin top-left, y down).
 */
export interface Stamp {
  index: number;
  x: number;
  y: number;
  prevX: number;
  prevY: number;
  /** Smoothed unit direction of travel. */
  dirX: number;
  dirY: number;
  prevDirX: number;
  prevDirY: number;
  /** Arc length from the start of the stroke. */
  distance: number;
  /** Milliseconds since the start of the stroke (interpolated along the path). */
  time: number;
}

export interface StrokeRenderer {
  /** Distance between stamps, in simulation pixels. */
  readonly spacing: number;
  /** Length (simulation px) over which the stroke direction is smoothed. 0 = no smoothing. */
  readonly directionSmoothing: number;
  stamp(s: Stamp): void;
  end(): void;
}

/** Opaque, GPU-resident copy of a session's canvas state. */
export interface StyleSnapshot {
  dispose(): void;
}

/**
 * Optional time-based behaviour (e.g. wet paint that keeps flowing).
 *
 * The core calls `tick()` at a fixed rate while `active` is true and records exactly when
 * each tick happened relative to commands and stamps, so replay (undo/redo, loading) is
 * exact. Ticks must therefore be deterministic: no wall-clock time, no Math.random.
 * Simulation state must be part of `snapshot()`.
 */
export interface Simulation {
  /** True while there is something left to simulate (e.g. paint still spreading). */
  readonly active: boolean;
  tick(): void;
}

export interface StyleSession {
  /** Clear the canvas to its initial state. */
  reset(): void;
  /**
   * Prepare a stroke. Must not change the canvas or simulation state: the stroke may be
   * created while earlier strokes are still being drawn. Do that work in `stamp()`.
   */
  beginStroke(toolId: string, settings: SettingValues, rng: Random): StrokeRenderer;
  runAction(actionId: string, settings: SettingValues, rng: Random): void;
  /**
   * Draw the final, lit image into `target` (RGBA8, same size as the simulation).
   * Only `dirty` needs to be updated.
   */
  render(target: GpuTarget, dirty: Rect): void;
  snapshot(): StyleSnapshot;
  restore(snapshot: StyleSnapshot): void;
  /** Optional fixed-rate simulation. */
  readonly simulation?: Simulation;
  dispose(): void;
}

export interface SessionContext {
  gpu: GpuToolkit;
  /** Simulation size in pixels. */
  width: number;
  height: number;
  /** Tell the core which area changed so it can re-render it. */
  markDirty(rect: Rect): void;
}

export interface StylePlugin {
  manifest: StyleManifest;
  phases: PhaseDefinition[];
  tools: ToolDefinition[];
  actions: ActionDefinition[];
  palettes: Palette[];
  createSession(ctx: SessionContext): StyleSession;
}

// ---------------------------------------------------------------------------
// GPU toolkit (implemented by the core, used by plugins)
// ---------------------------------------------------------------------------

export type TextureFormat = 'rgba8' | 'rgba16f';

export interface GpuTarget {
  readonly width: number;
  readonly height: number;
  readonly format: TextureFormat;
  readonly textures: readonly WebGLTexture[];
  dispose(): void;
}

export type UniformValue = number | readonly number[] | Float32Array | WebGLTexture;

export interface GpuProgram {
  setUniforms(values: Record<string, UniformValue>): void;
  dispose(): void;
}

export interface GpuCaps {
  /** Best texture format for simulation state on this device. */
  stateFormat: TextureFormat;
  maxTextureSize: number;
}

/**
 * GPU helpers. Programs are created from a fragment shader only; the core supplies
 * the vertex shader. Fragment shaders receive:
 *
 *   in vec2 vPos;   // pixel position in the target (simulation px, y down)
 *   in vec2 vAttr;  // per-vertex attribute supplied with the geometry
 *
 * and must declare `#version 300 es` themselves. Region programs see the target being
 * updated as `uniform sampler2D uSrc0, uSrc1, …` (read with texelFetch).
 */
export interface GpuToolkit {
  readonly gl: WebGL2RenderingContext;
  readonly caps: GpuCaps;
  createProgram(fragmentSource: string): GpuProgram;
  createTarget(
    width: number,
    height: number,
    options: { attachments: number; format: TextureFormat; linear?: boolean },
  ): GpuTarget;
  /** Clear each attachment to the given RGBA value. */
  clear(target: GpuTarget, values: readonly (readonly [number, number, number, number])[]): void;
  /**
   * Run `program` over the polygon `vertices` (triangle strip, 4 floats per vertex:
   * x, y, attrX, attrY in target pixels) and write the result back INTO `target`.
   * The program reads the previous contents through `uSrc0…uSrcN`.
   */
  updateInPlace(target: GpuTarget, program: GpuProgram, vertices: Float32Array): void;
  /** Run `program` over the polygon and write into `target` (no feedback). */
  draw(target: GpuTarget, program: GpuProgram, vertices: Float32Array, scissor?: Rect): void;
  /** Copy all attachments (optionally only `rect`). Both targets must have the same layout. */
  copy(source: GpuTarget, destination: GpuTarget, rect?: Rect): void;
}
