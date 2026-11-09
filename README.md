# Art Style Studio

A mobile-first web app for painting in artist-inspired styles. Each style is a plugin.

**First style: Colour Sweep**, inspired by the technique of Alex Voinea:
1. **Splodge**: drop blobs of colour (tap, drag, or *Scatter*).
2. **Bury**: pour white over them (*Pour* or *Cover all*).
3. **Sweep**: drag a broad brush through the wet paint. Buried colour is pulled up and smeared into long, streaky trails.

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

Deployment: `.github/workflows/ci.yml` tests every push and publishes the default branch to GitHub Pages.
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
- **GPU simulation.** Paint is two wet layers (top + buried) of colour and thickness in half-float textures. The sweep brush is a row of bristles, each carrying paint. On every step a bristle picks up paint ahead of it and lays it down behind. Lighting from the paint height gives the glossy look.
- **Touch first.** Browser gestures are blocked on the canvas. A short delay before painting starts lets a second finger turn the touch into navigation without leaving a mark. Lost GPU contexts are rebuilt by replaying the command log.

`npm run check:boundaries` enforces the dependency rules.

### Adding a style

1. Create `src/styles/<id>/index.ts` with a default export implementing `StylePlugin` from `@core/plugin-api`.
   It declares a manifest, phases, tools, actions, palettes and settings; the UI is generated from these.
2. Implement `createSession(ctx)`. You get a `GpuToolkit` (fragment-shader programs, multi-attachment targets, `updateInPlace` for read-modify-write passes), the canvas size, and `markDirty`. The core handles input smoothing, resampling, history, saving and export.
3. Add one line to `src/app/styles.ts`.
