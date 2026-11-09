# Art Style Studio — Architecture & Implementation Plan

> Status: **proposal, awaiting approval**. Nothing is implemented yet.

## 1. Goal

A mobile-first web app for making digital paintings in specific artists' techniques.
The first style follows the technique of **Alex Voinea**:

1. **Splodge** – drop blobs of saturated acrylic colour onto the canvas.
2. **Bury** – pour a thick layer of white over (most of) them.
3. **Sweep** – drag a broad brush / knife through the wet paint in bold, connected
   strokes. The buried colours get dragged up, smeared and streaked into the white,
   leaving glossy ribbons with bristle lines.

Each style is a **plugin**. The core app knows nothing about Voinea; it offers a canvas,
input, a GPU paint toolkit, history, storage and a UI shell. More styles can be added
later without touching the core.

## 2. Guiding principles

- **Core never depends on a plugin.** Plugins depend only on a public, versioned
  `@core/plugin-api` surface (types + services). Dependency rule enforced with ESLint
  (`import/no-restricted-paths`).
- **Rendering is separate from UI.** The paint engine is framework-free TypeScript; the
  UI is a thin layer that reads engine state and dispatches commands.
- **Strokes are data.** Every user action is a serialisable command in normalised canvas
  coordinates with a seeded RNG. This gives deterministic undo/redo via replay, saved
  projects that are tiny, and export at any resolution.
- **Touch first.** Designed and tested on phones first, desktop second.
- **Strict TypeScript, small modules, unit-testable pure logic.**

## 3. Tech stack

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript (strict) | Plugin contract is type-checked |
| Build | Vite | Fast, code-splitting for lazy-loaded plugins |
| UI | Preact + Signals (~5 kB) | Small, fast on low-end phones; engine stays framework-free |
| Rendering | WebGL2 (raw, thin wrapper) | Real-time wet-paint simulation needs the GPU; no heavy 3D library needed |
| Storage | IndexedDB (via `idb`) | Projects and stroke logs offline |
| Offline/install | PWA (`vite-plugin-pwa`) | Home-screen install, full-screen canvas on mobile |
| Tests | Vitest (unit), Playwright (e2e + mobile emulation + visual snapshots) | |
| Quality | ESLint, Prettier, GitHub Actions CI | |
| Hosting | Static (GitHub Pages / Netlify / Cloudflare Pages) | No backend needed |

## 4. High-level architecture

```
┌──────────────────────────────── UI shell (Preact) ────────────────────────────────┐
│ StylePicker · PhaseStepper · ToolDock · PaletteSheet · SettingsPanel (from schema) │
│ Gallery · Export/Share                                                             │
└───────────────▲─────────────────────────────────────────────┬──────────────────────┘
                │ signals (read-only state)                    │ commands
┌───────────────┴──────────────── Core ───────────────────────▼──────────────────────┐
│ Engine ── Document (canvas size, stroke log, active style, settings)                │
│   │      History (command log + GPU snapshot checkpoints → undo/redo)               │
│   │      Scheduler (rAF loop, dirty flags, frame budget)                            │
│ Input ── PointerInput → GestureRecognizer → StrokeBuilder (smoothing, resampling)   │
│ GPU ──── GlContext · ShaderProgram · PingPongTarget · TexturePool · StampRenderer   │
│          Compositor (lighting / gloss from paint height) · ContextLoss recovery     │
│ PluginHost ── PluginRegistry (lazy import) · PluginContext (services given to plugin)│
│ Storage ── ProjectStore (IndexedDB) · Exporter (PNG at N× via replay) · Share       │
└───────────────▲──────────────────────────────────────────────────────────────────────┘
                │ implements StylePlugin (only imports @core/plugin-api)
┌───────────────┴────────────── Style plugins ─────────────────────────────────────────┐
│ styles/voinea-sweep      (first)                                                     │
│ styles/<future-style>    (e.g. pour painting, impasto knife, ink wash …)             │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

## 5. The plugin contract (sketch)

```ts
// src/core/plugin-api/StylePlugin.ts
export interface StylePlugin {
  readonly manifest: {
    id: string;              // 'voinea-sweep'
    name: string;            // 'Colour Sweep'
    description: string;
    apiVersion: 1;           // host refuses incompatible plugins
    thumbnail: string;       // URL of a preview image
  };

  /** Ordered workflow steps shown in the PhaseStepper. Users may go back and forth. */
  phases: PhaseDefinition[];          // { id, label, icon, toolIds, hint }
  tools: ToolDefinition[];            // { id, label, icon, settingsSchema, defaults }
  palettes: Palette[];                // curated colour sets
  settingsSchema: SettingsSchema;     // UI is generated from this (sliders, toggles, colour)

  /** Called once when the style is activated on a document. */
  createSession(ctx: PluginContext): StyleSession;
}

export interface StyleSession {
  /** Allocate GPU state for a canvas of the given simulation size. */
  init(size: { width: number; height: number }): void;
  /** Apply one command (a stroke, a "pour white", a "scatter colours", …). Must be deterministic. */
  apply(cmd: StyleCommand, rng: SeededRandom): void;
  /** Incremental update while a stroke is live (for real-time feedback). */
  strokeUpdate(toolId: string, samples: StrokeSample[], settings: ToolSettings): void;
  /** Produce the frame (colour + height for core lighting). */
  render(target: RenderTarget): void;
  /** Snapshot / restore for history checkpoints and context-loss recovery. */
  snapshot(): StyleSnapshot;
  restore(s: StyleSnapshot): void;
  /** Optional one-tap "auto paint" for demos and inspiration. */
  generate?(seed: number): StyleCommand[];
  dispose(): void;
}

export interface PluginContext {
  gl: GpuToolkit;          // programs, ping-pong targets, stamp renderer, noise textures
  stroke: StrokeMath;      // arc-length resampling, tangents, pressure curves
  assets: AssetLoader;     // shaders, brush textures
  log: Logger;
}
```

Registration is a static list of lazy imports so each style is its own code-split chunk:

```ts
// src/app/styles.ts
export const styles = [
  { id: 'voinea-sweep', load: () => import('../styles/voinea-sweep') },
];
```

Adding a style = add a folder under `src/styles/` + one line here.

## 6. Voinea-style plugin: how the paint is simulated

The look depends on wet paint behaving like *layered, viscous material*, not pixels.
The simulation runs on the GPU at a fixed simulation resolution
(e.g. 1536 px long edge on phones, 2048–3072 on desktop; adaptive to GPU limits).

### 6.1 Canvas state (textures, ping-pong)
- `paintColor` – RGBA16F: pigment colour of the top visible paint.
- `paintHeight` – R16F: wet paint thickness (drives gloss/relief lighting and how much paint a stroke can move).
- `underColor` – RGBA16F + `underAmount`: buried colour beneath the white (two-layer model).
  Two layers is enough for this technique and keeps it fast; a general N-layer model is not needed.

### 6.2 Phase 1 — Splodge
- Tap = drop a blob; hold = blob grows; drag = drizzle trail.
- Blob shape = radial falloff distorted by seeded noise (organic edges), thickness peaks in the centre.
- “Scatter” button drops N random blobs from the chosen palette.

### 6.3 Phase 2 — Bury in white
- Drag or one-tap “Pour” to cover with white: existing colour moves into the `under` layer
  and a white layer of configurable thickness lies on top (thicker = colours appear softer when swept).
- Slight thickness noise so the white is not perfectly uniform.

### 6.4 Phase 3 — Sweep (the key part)
A **bristle-reservoir brush model**:
- The brush is a broad flat tool (width adjustable, typically 15–40 % of canvas width),
  always oriented perpendicular to the stroke direction.
- It is represented as a 1-D row of *bristles* (a 1×N texture). Each bristle carries
  a small reservoir of colour + amount.
- At each stamp step (samples spaced evenly by arc length along the smoothed path):
  1. **Pick-up:** each bristle takes paint from beneath it. Brush *pressure/depth*
     controls how much of the `under` layer comes up versus the white top layer.
  2. **Mix & deposit:** the bristle lays down a mix of its reservoir and the canvas,
     dragging colour forward → long smears and gradients.
  3. **Streaks:** per-bristle noise in pick-up rate produces the fine parallel lines.
  4. **Ridges:** paint is pushed aside, building up height at the brush edges and stroke end.
- Strokes are long and connected: the reservoir persists for the whole stroke, so colour
  picked up at the start keeps smearing through the white until exhausted.

### 6.5 Rendering
- Compositor computes normals from `paintHeight` and adds a soft specular highlight →
  the glossy, wet acrylic look. Toggle “wet / dry look”.
- Final colour uses a simple subtractive-ish mix (mix in linear space with a
  saturation-preserving tweak) so red + blue smeared together doesn't turn muddy grey too quickly.

### 6.6 Settings exposed (auto-generated UI)
Brush width, depth (how much buried colour is pulled up), wetness/smear length,
streak intensity, white thickness, palette, gloss.

## 7. Input & mobile — "must work flawlessly"

| Problem | Solution |
|---|---|
| Browser scroll/zoom/pull-to-refresh hijacks drawing | `touch-action: none` on canvas, `overscroll-behavior: none`, viewport `user-scalable=no`, prevent `gesturestart` on iOS |
| Choppy strokes | `getCoalescedEvents()` for every hardware sample; `getPredictedEvents()` for low-latency preview; one-euro filter + Catmull-Rom smoothing; arc-length resampling |
| Paint vs. navigate | GestureRecognizer: 1 finger = paint; 2 fingers = pan/pinch-zoom/rotate the view; a stroke that turns into a 2-finger gesture within ~80 ms is cancelled (no stray marks) |
| Two-finger tap / three-finger tap | Undo / redo (like Procreate) plus visible buttons |
| Palm and stylus | If a pen is active, ignore touch for painting (palm rejection); use pen pressure/tilt when available |
| Pressure on fingers | Velocity → simulated pressure fallback (fast = lighter) |
| Lost pointers | `setPointerCapture`; handle `pointercancel`, `lostpointercapture`, `visibilitychange` cleanly |
| Hi-DPI / memory | Display canvas at devicePixelRatio, but simulation resolution capped by device class & `MAX_TEXTURE_SIZE`; float-texture capability checks with RGBA8 fallback |
| GPU context lost (common on iOS when backgrounded) | Listen for `webglcontextlost/restored`; rebuild from last snapshot + command log replay |
| Layout | Full-bleed canvas, safe-area insets, bottom-docked toolbar reachable by thumb, ≥44 px targets, bottom sheets for palette/settings, portrait & landscape |
| Feedback | Optional haptics (`navigator.vibrate`) on phase change / undo where supported |

## 8. History, persistence, export
- **Commands**: `{type, toolId, settings, samples[], seed}` in normalised (0–1) coordinates.
- **Undo/redo**: GPU snapshot every K commands (ring buffer, memory-capped); undo = restore
  nearest snapshot and replay the commands after it. Deterministic seeded RNG makes this exact.
- **Autosave** to IndexedDB (debounced) — survives tab reloads and app switching on mobile.
- **Gallery** of saved paintings with thumbnails.
- **Export** PNG at screen resolution or high-res (replays the log at a bigger simulation size,
  in tiles if needed); **Share** via Web Share API (falls back to download).
- **Timelapse** (stretch goal): replay the log and record via `MediaRecorder`.

## 9. Proposed folder structure

```
src/
  app/                 main.ts, styles.ts (plugin list), AppController
  core/
    plugin-api/        public types for plugins (the ONLY thing plugins import)
    engine/            Engine, Document, History, Scheduler, SeededRandom
    input/             PointerInput, GestureRecognizer, StrokeBuilder, OneEuroFilter
    gpu/               GlContext, ShaderProgram, PingPongTarget, TexturePool, StampRenderer, Compositor
    view/              ViewTransform (pan / zoom / rotate)
    storage/           ProjectStore, Exporter, Share
  styles/
    voinea-sweep/
      index.ts         manifest + plugin object
      phases.ts tools.ts palettes.ts settings.ts
      session/         SweepSession, BristleBrush, Splodge, PourWhite
      shaders/         *.glsl
  ui/
    components/        CanvasView, PhaseStepper, ToolDock, PaletteSheet, SettingsPanel, Gallery …
    state/             signals bridging engine → UI
tests/
  unit/                stroke math, gestures, history, registry, schema → UI
  e2e/                 Playwright: mobile (iPhone/Pixel emulation) + desktop flows
  visual/              deterministic replays → screenshot comparisons
```

## 10. Milestones

| # | Deliverable | Done when |
|---|---|---|
| M0 | Scaffold: Vite + TS strict + Preact + lint + tests + CI + PWA shell | CI green, installable empty app |
| M1 | Core: GPU toolkit, input pipeline, gestures, view pan/zoom, plugin API & registry, a tiny **"debug brush" plugin** to prove the contract | Can paint simple strokes smoothly on a phone; plugin is lazy-loaded |
| M2 | Voinea plugin: splodge, bury, bristle sweep, gloss compositor | Results recognisably resemble the technique |
| M3 | Mobile UI polish: phase stepper, palettes, bottom sheets, auto-generated settings, haptics | Usable one-handed on a phone |
| M4 | History & persistence: undo/redo, autosave, gallery, export, share, context-loss recovery | No lost work on app switching |
| M5 | Hardening: performance budget (60 fps on mid-range phones), e2e + visual tests, real-device check on iOS Safari & Android Chrome, accessibility pass | Test matrix green |

Stretch: auto-paint generator, timelapse video, second style plugin to validate the abstraction.

## 11. Risks
- **Getting the look right** is the hardest part → M2 starts with a quick prototype and
  reference comparisons; parameters tuned together with you.
- **iOS Safari WebGL quirks** (float textures, context loss, memory) → capability detection, fallbacks, early real-device testing.
- **Naming**: the app/plugin should say "inspired by" rather than use the artist's name as branding.

## 12. Open questions
1. UI framework: Preact OK, or do you prefer React / Svelte / Vue?
2. Hosting target (GitHub Pages?) and whether offline/PWA install is wanted.
3. Strict three-phase workflow, or free switching between tools at any time (proposal: guided phases, but freely revisitable)?
4. Square canvas only, or user-selectable aspect ratios (e.g. 1:1, 4:5, 9:16)?
5. Is a stylus (Apple Pencil) a key use case, or mainly fingers?
