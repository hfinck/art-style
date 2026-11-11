# Art Style Studio

A mobile-first web app for painting in artist-inspired styles. Each style is a plugin.

**First style: Colour Sweep**, inspired by the technique of Alex Voinea:
1. **Splodge**: pour colour. Tap for a blob, hold to keep pouring, drag for a trail.
   Pouring into a puddle pushes the earlier colours outward into rings without mixing them,
   and puddles keep spreading for a moment afterwards. *Scatter* pours several ring stacks at once.
2. **Bury** (optional): pour white over them (*Pour* or *Cover all*).
3. **Sweep**: drag a broad brush through the wet paint. It pushes a bead of wet paint that mixes with
   the puddles it crosses and slowly spreads along the brush, while colours dragged in the bristles
   stretch into streaks. Fast strokes and sharp turns fling
   splashes of the carried paint outward.

## Use

| Gesture | Action |
|---|---|
| 1 finger | paint |
| 2 fingers drag / pinch / twist | pan / zoom / rotate the view |
| 2-finger tap | undo |
| 3-finger tap | redo |
| Mouse wheel / trackpad pinch | zoom; right or middle drag pans |

Paintings autosave in the browser (IndexedDB). The share button exports a PNG through the system share sheet, or downloads it where sharing isn't available.

## Develop

```bash
npm install
npm run dev          # http://localhost:5173
npm test             # unit tests (Vitest)
npm run test:e2e     # Playwright: mobile (touch) + desktop
npm run ci           # boundaries + typecheck + unit tests + build
```

Deployment: `.github/workflows/ci.yml` tests every push and publishes `main` to GitHub Pages.
Enable it once under **Settings → Pages → Source: GitHub Actions**.

## Architecture

```
src/
  core/                 style-agnostic engine (never imports ui/app/styles)
    plugin-api/         the ONLY module style plugins may import
    engine/             Engine, History (checkpoints + replay), PluginRegistry, formats
    gpu/                WebGL2 toolkit, in-place region updates, presenter
    input/              pointer binding, gesture recognizer, one-euro filter, spline resampler
    view/               pan / zoom / rotate transform
    storage/            IndexedDB project store, PNG export / share
  styles/voinea-sweep/  the Colour Sweep plugin (shaders + tools + palettes)
  ui/                   Preact components + AppController (signals)
  app/styles.ts         list of installed styles (lazy imports)
```

Key ideas:
- **Strokes are data.** Every stroke is stored as filtered input points in normalised coordinates, with a random seed.
  Undo restores the nearest GPU checkpoint and replays the commands after it. Replay is bit-identical to live painting (an e2e test checks this).
- **Input never drops.** All coalesced pointer samples are kept. Stamps are queued and drawn under a per-frame budget that adapts to the frame rate, so fast strokes catch up instead of skipping.
- **GPU paint model.** Paint is two wet layers (top + buried) of colour and thickness in half-float textures. Lighting from the paint height gives the glossy look.
  - *Pouring* is an area-preserving radial push: new paint appears at the centre and existing paint moves outward, so colours form rings instead of mixing.
  - *Spreading* stretches a puddle around its pour point and eases out. Rings stay crisp and get thinner.
  - *Sweeping* scrapes most of the paint under the brush off the canvas (a thin mark of what was there stays) and carries it in two places, per bristle. The *bead* in front of the brush is a body of liquid: it mixes what it picks up (by volume, weighted by tinting strength), flows sideways from high to low (faster the more paint there is, and less per distance on fast strokes), lays down a film that thins as it runs out (dry-brush streaks), and is partly left behind as a mound when the brush lifts. The *grooves* between bristles release what they drew in evenly over a delay that varies across the brush, which stretches colours into pure streaks without mixing neighbouring lines (a ring buffer of per-step intake). Speed and turning rate (from timestamped input) drive momentum splashes.
- **Time-based simulation with exact replay.** Styles can expose a `simulation` that the core ticks at a fixed 30 Hz. The engine records when each tick happened relative to commands and stamps, so undo/redo and loading replay the flowing paint exactly.
- **Touch first.** Browser gestures are blocked on the canvas. A short delay before painting starts lets a second finger turn the touch into navigation without leaving a mark. Lost GPU contexts are rebuilt by replaying the command log.

`npm run check:boundaries` enforces the dependency rules.

### Adding a style

1. Create `src/styles/<id>/index.ts` with a default export implementing `StylePlugin` from `@core/plugin-api`.
   It declares a manifest, phases, tools, actions, palettes and settings; the UI is generated from these.
2. Implement `createSession(ctx)`. Optionally expose `simulation` for time-based behaviour (it must be deterministic and included in snapshots). You get a `GpuToolkit` (fragment-shader programs, multi-attachment targets, `updateInPlace` for read-modify-write passes), the canvas size, and `markDirty`. The core handles input smoothing, resampling, history, saving and export.
3. Add one line to `src/app/styles.ts`.
