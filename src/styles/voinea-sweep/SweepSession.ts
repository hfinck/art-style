import {
  boundsOf,
  hexToRgb,
  rectVertices,
  type ColorChoice,
  type GpuProgram,
  type GpuTarget,
  type Random,
  type Rect,
  type SessionContext,
  type SettingValues,
  type Simulation,
  type Stamp,
  type StrokeRenderer,
  type StyleSession,
  type StyleSnapshot,
} from '@core/plugin-api';
import { CANVAS, WHITE } from './palettes';
import {
  DEPOSIT_FS,
  DROPLET_FS,
  INJECT_FS,
  PICKUP_FS,
  RELEASE_FS,
  POUR_FS,
  RENDER_FS,
  SPREAD_FS,
} from './shaders';

const BRISTLES = 192;
/** Rows of brush paint history (one per step, ring buffer); bounds the longest groove delay. */
const HISTORY = 512;
/** Bead volume the brush can push before paint spills under it (see shaders BRUSH). */
const BEAD_CAPACITY = 0.12;

type RGB = [number, number, number];

const num = (s: SettingValues, id: string, fallback: number): number => {
  const v = s[id];
  return typeof v === 'number' ? v : fallback;
};

function pickColor(s: SettingValues, rng: Random): RGB {
  const c = s['color'] as ColorChoice | undefined;
  if (!c || c.colors.length === 0) return hexToRgb('#ff2d55');
  return hexToRgb(c.mode === 'random' ? rng.pick(c.colors) : c.colors[0]!);
}

function expand(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by, w: r.w + 2 * by, h: r.h + 2 * by };
}

/** A place where paint is being poured (follows the finger while it is down). */
interface PourSource {
  x: number;
  y: number;
  color: RGB;
  amount: number;
  phase: [number, number, number, number];
  /** r² still to pour from the initial gush. */
  pending: number;
  /** r² poured per tick while the finger is down. */
  rate: number;
  /** r² of the puddle being pushed (sets how far the push reaches). */
  total: number;
  /** Finger lifted: only the remaining gush is poured. */
  lifted: boolean;
  /** How the puddle spreads once pouring stops. */
  spreadTicks: number;
  spreadRate: number;
  /** Index of the puddle this pour belongs to. */
  puddle: number;
}

/** A puddle of poured paint. Later pours into it push all of its rings; it spreads as a whole. */
interface Puddle {
  x: number;
  y: number;
  /** r² of the puddle (px²). */
  total: number;
  phase: [number, number, number, number];
  spreadLeft: number;
  spreadTicks: number;
  spreadRate: number;
}

interface SimState {
  sources: PourSource[];
  puddles: Puddle[];
}

const MAX_PUDDLES = 96;

interface Snapshot extends StyleSnapshot {
  target: GpuTarget;
  sim: SimState;
}

/**
 * Canvas model for the Colour Sweep style: two layers of liquid paint on the GPU
 * (top + paint buried under white), a fixed-rate flow simulation, and the tools of the
 * technique (pour, bury, sweep).
 */
export class SweepSession implements StyleSession, Simulation {
  private readonly paint: GpuTarget;
  /** Second state buffer for passes that read far-away pixels (flow, pour push). */
  private readonly back: GpuTarget;
  /** The paint on the brush per step and bristle: bead in front (0), drawn into the grooves (1). */
  private readonly history: GpuTarget;
  private readonly inject: GpuProgram;
  private readonly spread: GpuProgram;
  private readonly droplet: GpuProgram;
  private readonly pour: GpuProgram;
  private readonly pickup: GpuProgram;
  private readonly deposit: GpuProgram;
  private readonly release: GpuProgram;
  private readonly composite: GpuProgram;
  private readonly bg = hexToRgb(CANVAS);
  private readonly white = hexToRgb(WHITE);
  readonly shortSide: number;
  private sim: SimState = { sources: [], puddles: [] };

  constructor(private readonly ctx: SessionContext) {
    const { gpu, width, height } = ctx;
    const format = gpu.caps.stateFormat;
    this.shortSide = Math.min(width, height);
    this.paint = gpu.createTarget(width, height, { attachments: 2, format });
    this.back = gpu.createTarget(width, height, { attachments: 2, format });
    this.history = gpu.createTarget(BRISTLES, HISTORY, { attachments: 2, format });
    this.inject = gpu.createProgram(INJECT_FS);
    this.spread = gpu.createProgram(SPREAD_FS);
    this.droplet = gpu.createProgram(DROPLET_FS);
    this.pour = gpu.createProgram(POUR_FS);
    this.pickup = gpu.createProgram(PICKUP_FS);
    this.deposit = gpu.createProgram(DEPOSIT_FS);
    this.release = gpu.createProgram(RELEASE_FS);
    this.composite = gpu.createProgram(RENDER_FS);
    const size = [width, height];
    for (const p of [this.inject, this.spread, this.pickup, this.composite]) {
      p.setUniforms({ uSize: size, uBg: this.bg });
    }
    this.pickup.setUniforms({ uCount: BRISTLES });
    this.deposit.setUniforms({
      uCount: BRISTLES,
      uRows: HISTORY,
      uHistory: this.history.textures[0]!,
      uGrooves: this.history.textures[1]!,
    });
    this.release.setUniforms({ uCount: BRISTLES });
    this.droplet.setUniforms({ uCount: BRISTLES, uHistory: this.history.textures[0]! });
    this.composite.setUniforms({ uGloss: 0.6, uRelief: 26 });
  }

  get simulation(): Simulation {
    return this;
  }

  private get full(): Rect {
    return { x: 0, y: 0, w: this.ctx.width, h: this.ctx.height };
  }

  reset(): void {
    const [r, g, b] = this.bg;
    this.ctx.gpu.clear(this.paint, [
      [r, g, b, 0],
      [r, g, b, 0],
    ]);
    this.sim = { sources: [], puddles: [] };
    this.ctx.markDirty(this.full);
  }

  // ---------------------------------------------------------------------------
  // Simulation: wet paint keeps flowing for a while after it was touched
  // ---------------------------------------------------------------------------

  get active(): boolean {
    return this.sim.sources.length > 0 || this.sim.puddles.some((p) => p.spreadLeft > 0);
  }

  tick(): void {
    const { sources, puddles } = this.sim;
    const pouringInto = new Set<number>();
    for (const src of sources) {
      // New paint at the centre pushes the existing paint outward.
      const gush = Math.min(src.pending, Math.max(src.rate, this.shortSide * this.shortSide * 0.0004) * 2.5);
      src.pending -= gush;
      const area = gush + (src.lifted ? 0 : src.rate);
      if (area > 0) this.pushPaint(src, area);
      const puddle = puddles[src.puddle];
      if (!puddle) continue;
      puddle.total = Math.max(puddle.total, src.total);
      pouringInto.add(src.puddle);
      if (src.lifted && src.pending <= 1e-3) {
        // Pouring finished: the whole puddle (re)starts spreading.
        puddle.spreadTicks = puddle.spreadLeft = src.spreadTicks;
        puddle.spreadRate = src.spreadRate;
      }
    }
    this.sim.sources = sources.filter((s) => !s.lifted || s.pending > 1e-3);
    // Puddles spread, slowing down to a stop.
    puddles.forEach((p, i) => {
      if (p.spreadLeft <= 0 || pouringInto.has(i)) return;
      const ease = p.spreadLeft / p.spreadTicks;
      p.spreadLeft--;
      this.spreadPuddle(p, 1 + p.spreadRate * ease * ease);
    });
  }

  /** The puddle under (x, y), or a new one. Deterministic: depends only on simulation state. */
  private puddleAt(x: number, y: number, phase: [number, number, number, number]): number {
    const list = this.sim.puddles;
    let best = -1;
    let bestD = Infinity;
    list.forEach((p, i) => {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < Math.sqrt(p.total) * 1.1 && d < bestD) {
        best = i;
        bestD = d;
      }
    });
    if (best >= 0) return best;
    list.push({ x, y, total: 0, phase, spreadLeft: 0, spreadTicks: 1, spreadRate: 0 });
    if (list.length > MAX_PUDDLES) {
      list.shift();
      for (const s of this.sim.sources) s.puddle--;
    }
    return list.length - 1;
  }

  private spreadPuddle(p: Puddle, scale: number): void {
    const R = Math.sqrt(p.total) * 1.05;
    const pad = (R * 1.1 + Math.max(40, R * 0.7)) * 1.2 + 2;
    this.spread.setUniforms({
      uSrc0: this.paint.textures[0]!,
      uSrc1: this.paint.textures[1]!,
      uCenter: [p.x, p.y],
      uScale: scale,
      uRadius: R,
      uWobble: 1,
      uPhase: p.phase,
    });
    this.nonLocal(this.spread, { x: p.x - pad, y: p.y - pad, w: pad * 2, h: pad * 2 });
    p.total *= scale * scale;
  }

  /** Run a program that reads arbitrary pixels: render into the back buffer, then copy back. */
  private nonLocal(program: GpuProgram, area: Rect): void {
    const r = clip(area, this.ctx.width, this.ctx.height);
    if (r.w <= 0 || r.h <= 0) return;
    this.ctx.gpu.draw(this.back, program, rectVertices(r.x, r.y, r.w, r.h), r);
    this.ctx.gpu.copy(this.back, this.paint, r);
    this.ctx.markDirty(r);
  }

  /** Pour `area` (px²) of a source's paint at its position. */
  private pushPaint(src: PourSource, area: number, reachRadius?: number): void {
    // Trail pours (with an explicit reach) do not grow the puddle that later spreads.
    if (reachRadius === undefined) src.total += area;
    const R = reachRadius ?? Math.sqrt(src.total);
    const reach0 = 1.4 * R + 12;
    const reach1 = 2.4 * R + 50;
    const { x, y } = src;
    const pad = reach1 * 1.25 + 2;
    this.inject.setUniforms({
      uSrc0: this.paint.textures[0]!,
      uSrc1: this.paint.textures[1]!,
      uCenter: [x, y],
      uArea: area,
      uReach0: reach0,
      uReach1: reach1,
      uColor: src.color,
      uAmount: src.amount,
      // Many overlapping wobbly pushes along a trail would scallop its edges.
      uWobble: reachRadius === undefined ? 1 : 0,
      uPhase: src.phase,
    });
    const rect = { x: x - pad, y: y - pad, w: pad * 2, h: pad * 2 };
    this.nonLocal(this.inject, rect);
  }

  // ---------------------------------------------------------------------------
  // Tools
  // ---------------------------------------------------------------------------

  beginStroke(toolId: string, settings: SettingValues, rng: Random): StrokeRenderer {
    switch (toolId) {
      case 'drop':
        return this.dropStroke(settings, rng);
      case 'pour':
        return this.pourStroke(settings, rng);
      case 'broad':
      case 'detail':
        return this.sweepStroke(settings, rng);
      default:
        throw new Error(`Unknown tool "${toolId}"`);
    }
  }

  runAction(actionId: string, settings: SettingValues, rng: Random): void {
    switch (actionId) {
      case 'scatter':
        this.scatter(settings, rng);
        return;
      case 'cover':
        this.pourWhite(0, 0, 0, num(settings, 'thickness', 60) / 100, rng.range(0, 100), true);
        return;
      default:
        throw new Error(`Unknown action "${actionId}"`);
    }
  }

  /** How long and how far a puddle keeps spreading after pouring. */
  private spreadFor(settings: SettingValues): { ticks: number; rate: number } {
    const f = num(settings, 'flow', 60) / 100;
    const ticks = Math.round(20 + 100 * f);
    // Total radius growth ≈ exp(rate * ticks / 3): up to ~1.8× at full fluidity.
    const growth = 1 + 0.4 * f;
    return { ticks, rate: (3 * Math.log(growth)) / ticks };
  }

  private newSource(x: number, y: number, settings: SettingValues, rng: Random, radius: number, puddleIndex?: number): PourSource {
    const pourRate = num(settings, 'pour', 45) / 100;
    const spread = this.spreadFor(settings);
    const color = pickColor(settings, rng);
    const phase: [number, number, number, number] = [rng.range(0, 6.283), rng.range(0, 6.283), rng.range(0, 6.283), rng.range(0, 6.283)];
    const puddle = puddleIndex ?? this.puddleAt(x, y, phase);
    return {
      puddle,
      spreadTicks: spread.ticks,
      spreadRate: spread.rate,
      x,
      y,
      color,
      amount: 0.2 + 0.5 * (num(settings, 'thickness', 55) / 100),
      // Pouring into an existing puddle continues its outline.
      phase: this.sim.puddles[puddle]?.phase ?? phase,
      pending: radius * radius,
      rate: pourRate * pourRate * (this.shortSide * this.shortSide) / 900,
      // Pouring into an existing puddle pushes all of it, not just the new paint.
      total: this.sim.puddles[puddle]?.total ?? 0,
      lifted: false,
    };
  }

  /** Pour colour: tap for a blob, hold to keep pouring, drag for a trail. */
  private dropStroke(settings: SettingValues, rng: Random): StrokeRenderer {
    const variation = num(settings, 'variation', 30) / 100;
    const radius = (num(settings, 'size', 10) / 100) * this.shortSide * 0.5 * (1 + rng.range(-0.5, 0.5) * variation);
    const spacing = Math.max(2, radius * 0.06);
    const session = this;
    let source: PourSource | null = null;
    return {
      spacing,
      directionSmoothing: 0,
      stamp(s: Stamp) {
        if (!source) {
          source = session.newSource(s.x, s.y, settings, rng, radius);
          session.sim.sources.push(source);
        } else {
          // Dragging pours a trail: paint is pushed aside along the path.
          source.x = s.x;
          source.y = s.y;
          session.pushPaint(source, radius * 0.25 * spacing, radius * 0.6);
        }
      },
      end() {
        if (source) source.lifted = true;
      },
    };
  }

  /** Several pours, some with multiple colours poured into each other (rings). */
  private scatter(settings: SettingValues, rng: Random): void {
    const { width, height } = this.ctx;
    const count = Math.round(num(settings, 'count', 9));
    const maxRings = Math.max(1, Math.round(num(settings, 'rings', 3)));
    const base = (num(settings, 'size', 11) / 100) * this.shortSide * 0.5;
    const placed: { x: number; y: number; r: number }[] = [];
    for (let i = 0; i < count; i++) {
      let best = { x: width / 2, y: height / 2, r: base };
      let bestScore = -Infinity;
      for (let k = 0; k < 12; k++) {
        const r = base * rng.range(0.6, 1.4);
        const c = { x: rng.range(0.12, 0.88) * width, y: rng.range(0.12, 0.88) * height, r };
        let score = Infinity;
        for (const p of placed) score = Math.min(score, Math.hypot(p.x - c.x, p.y - c.y) - (p.r + c.r) * 1.1);
        if (score > bestScore) {
          bestScore = score;
          best = c;
        }
      }
      placed.push(best);
      // Pour 1..maxRings colours into the same spot; each one pushes the previous outward.
      const rings = 1 + rng.int(0, maxRings);
      let lastColor: string | null = null;
      const puddleIndex = this.puddleAt(best.x, best.y, [rng.range(0, 6.283), rng.range(0, 6.283), rng.range(0, 6.283), rng.range(0, 6.283)]);
      let stack = this.sim.puddles[puddleIndex]!.total;
      for (let k = 0; k < rings; k++) {
        const choice = settings['color'] as ColorChoice | undefined;
        const colors = choice?.colors ?? ['#ff2d55'];
        let hex = choice?.mode === 'random' ? rng.pick(colors) : colors[0]!;
        if (choice?.mode === 'random' && colors.length > 1) while (hex === lastColor) hex = rng.pick(colors);
        lastColor = hex;
        const src = this.newSource(best.x, best.y, settings, rng, 0, puddleIndex);
        src.color = hexToRgb(hex);
        const r = best.r * (k === 0 ? 1 : rng.range(0.45, 0.8));
        src.total = stack;
        stack += r * r;
        this.pushPaint(src, r * r);
      }
      // The stack keeps spreading as one puddle.
      const puddle = this.sim.puddles[puddleIndex]!;
      const spread = this.spreadFor(settings);
      puddle.total = stack;
      puddle.spreadTicks = puddle.spreadLeft = spread.ticks;
      puddle.spreadRate = spread.rate;
    }
  }

  private pourWhite(x: number, y: number, radius: number, thickness: number, seed: number, full = false): void {
    const pad = radius * 1.1 + 2;
    const verts = full
      ? rectVertices(0, 0, this.ctx.width, this.ctx.height)
      : rectVertices(x - pad, y - pad, pad * 2, pad * 2);
    this.pour.setUniforms({
      uCenter: [x, y],
      uRadius: Math.max(radius, 1),
      uFull: full ? 1 : 0,
      uWhite: this.white,
      uThickness: 0.12 + 0.5 * thickness,
      uSeed: seed,
    });
    this.ctx.gpu.updateInPlace(this.paint, this.pour, verts);
    this.ctx.markDirty(full ? this.full : expand(boundsOf(verts, 4), 2));
  }

  private pourStroke(settings: SettingValues, rng: Random): StrokeRenderer {
    const radius = (num(settings, 'size', 22) / 100) * this.shortSide * 0.5;
    const thickness = num(settings, 'thickness', 60) / 100;
    const seed = rng.range(0, 100);
    const session = this;
    return {
      spacing: Math.max(1.5, radius * 0.15),
      directionSmoothing: 0,
      stamp(s: Stamp) {
        session.pourWhite(s.x, s.y, radius, thickness, seed);
      },
      end() {},
    };
  }

  private sweepStroke(settings: SettingValues, rng: Random): StrokeRenderer {
    const width = Math.max(4, (num(settings, 'width', 38) / 100) * this.shortSide);
    const smearPx = Math.max(4, (num(settings, 'smear', 45) / 100) * this.shortSide);
    const spacing = Math.min(3, Math.max(1, width * 0.006));
    const margin = Math.max(3, width * 0.03);
    const depth = num(settings, 'depth', 65) / 100;
    const splash = num(settings, 'splash', 55) / 100;
    const seed = rng.range(0, 50);
    const gpu = this.ctx.gpu;
    const stepFrac = spacing / width;
    const film = 0.35 * (num(settings, 'coverage', 92) / 100);

    // Programs are shared between strokes, so per-stroke uniforms are applied on every stamp
    // (a new stroke may begin while the previous one still has queued stamps).
    const brushUniforms = {
      uWidthPx: width,
      uDepth: depth,
      uStreak: num(settings, 'streaks', 50) / 100,
      uSeed: seed,
      uScrape: 0.62 + 0.33 * depth,
      uPass: 0.06,
      uGroove: 0.65,
      uFilm: film,
      // Over bare canvas the bead runs out over roughly a third of the smear length.
      uHalf: (film * smearPx * 0.3) / width,
      uCapacity: BEAD_CAPACITY,
      uMobile: 0.04,
      uStepFrac: stepFrac,
    };
    const depositUniforms = {
      uRidge: num(settings, 'ridges', 45) / 100,
      uMargin: margin / width,
      uLagMax: Math.min(HISTORY - 1, Math.round(smearPx / spacing)),
    };
    // A full bead spreads along the brush by about a quarter of its width (standard deviation)
    // per brush width travelled; the pairwise scheme is stable up to 1/16.
    const flow = Math.min(1 / 16, ((0.25 * BRISTLES) ** 2 * stepFrac) / 408);

    // Momentum: smoothed speed (canvas short sides per second) and turning rate.
    let speed = 0;
    let lastTime = 0;
    let lastStamp: Stamp | null = null;
    let step = 0;

    const session = this;
    const fling = (s: Stamp, energy: number, turn: number) => {
      // Expected droplets for this step; the stroke's RNG keeps it deterministic.
      let expected = Math.min(energy, 3) * splash * spacing * 0.025;
      let n = 0;
      // Flung paint comes from the bead.
      const row = step % HISTORY;
      while (n < 4 && rng.next() < expected) {
        expected -= 1;
        n++;
        const nx = -s.dirY, ny = s.dirX;
        // Paint leaves from the outside of a turn, or from either edge when going straight.
        const side = Math.abs(turn) > 0.002 ? (turn > 0 ? -1 : 1) : rng.next() < 0.5 ? -1 : 1;
        const u = side > 0 ? 1 - rng.range(0, 0.2) : rng.range(0, 0.2);
        const bx = s.x + nx * (u - 0.5) * width;
        const by = s.y + ny * (u - 0.5) * width;
        const angle = rng.range(0.15, 1.1) * side;
        const c = Math.cos(angle), sn = Math.sin(angle);
        const tx = s.dirX * c + nx * sn;
        const ty = s.dirY * c + ny * sn;
        const reach = width * rng.range(0.04, 0.3) * Math.min(3, 0.5 + energy * 0.5);
        const size = width * rng.range(0.004, 0.016) * (1 + Math.min(energy, 3) * 0.25);
        // Main droplet plus a tapering tail back towards the brush.
        const parts = size > 4 ? 2 + rng.int(0, 3) : 0;
        for (let k = 0; k <= parts; k++) {
          const f = 1 - k / (parts + 1);
          const r = Math.max(3, size * (k === 0 ? 1 : 0.35 + 0.5 * f));
          session.drop(bx + tx * reach * f, by + ty * reach * f, tx, ty, r * rng.range(1.4, 3.2), r, u, row);
        }
      }
    };

    return {
      spacing,
      directionSmoothing: width * 0.3,
      stamp(s: Stamp) {
        const pnx = -s.prevDirY, pny = s.prevDirX;
        const cnx = -s.dirY, cny = s.dirX;
        const dt = s.time - lastTime;
        if (s.index > 0 && dt > 0.01) {
          const v = ((spacing / dt) * 1000) / session.shortSide; // short sides per second
          speed += (v - speed) * Math.min(1, spacing / (width * 0.05));
          lastTime = s.time;
        }
        // 1. Update the bead. A fast brush gives it less time to flow sideways per distance.
        const row = step % HISTORY;
        session.pickup.setUniforms(brushUniforms);
        session.pickup.setUniforms({
          uPaint0: session.paint.textures[0]!,
          uPaint1: session.paint.textures[1]!,
          uPrevRow: (step + HISTORY - 1) % HISTORY,
          uFresh: s.index === 0 ? 1 : 0,
          uFlow: flow * Math.min(1.2, Math.max(0.6, 1.2 - 0.25 * speed)),
          uDistance: s.distance,
          uPrevPos: [s.prevX, s.prevY],
          uCurPos: [s.x, s.y],
          uPrevNormal: [pnx, pny],
          uCurNormal: [cnx, cny],
        });
        gpu.updateInPlace(session.history, session.pickup, rectVertices(0, row, BRISTLES, 1));
        if (s.index === 0) {
          lastTime = s.time;
          lastStamp = s;
          step++;
          return; // first contact: the brush starts empty
        }

        // 2. Move the paint under the swept quad (triangle strip).
        const h = width / 2 + margin;
        const um = margin / width;
        const verts = new Float32Array([
          s.prevX - pnx * h, s.prevY - pny * h, -um, 0,
          s.prevX + pnx * h, s.prevY + pny * h, 1 + um, 0,
          s.x - cnx * h, s.y - cny * h, -um, 1,
          s.x + cnx * h, s.y + cny * h, 1 + um, 1,
        ]);
        session.deposit.setUniforms(brushUniforms);
        session.deposit.setUniforms(depositUniforms);
        session.deposit.setUniforms({ uRow: row, uStep: step, uDistance: s.distance });
        gpu.updateInPlace(session.paint, session.deposit, verts);
        session.ctx.markDirty(expand(boundsOf(verts, 4), 2));

        // 3. Momentum splashes.
        const turn = s.prevDirX * s.dirY - s.prevDirY * s.dirX; // radians per step (signed)
        const curvature = Math.abs(turn) / spacing; // 1/px
        const centripetal = speed * speed * curvature * session.shortSide;
        const energy = Math.max(0, speed - 1.4) * 0.8 + Math.max(0, centripetal - 4) * 0.15;
        if (energy > 0 && splash > 0) fling(s, energy, turn);
        lastStamp = s;
        step++;
      },
      end() {
        const s = lastStamp;
        if (!s || s.index === 0) return;
        // Stopping fast: the carried paint keeps going and splashes ahead of the brush.
        if (speed > 1.6 && splash > 0) fling(s, (speed - 1.6) * 2, 0);
        // The rest of the bead stays where the brush is lifted.
        const nx = -s.dirY, ny = s.dirX;
        const len = width * 0.3;
        const hw = width / 2;
        const verts = new Float32Array([
          s.x - nx * hw, s.y - ny * hw, 0, 0,
          s.x + nx * hw, s.y + ny * hw, 1, 0,
          s.x - nx * hw + s.dirX * len, s.y - ny * hw + s.dirY * len, 0, len,
          s.x + nx * hw + s.dirX * len, s.y + ny * hw + s.dirY * len, 1, len,
        ]);
        session.release.setUniforms({
          uHistory: session.history.textures[0]!,
          uRow: (step + HISTORY - 1) % HISTORY,
          uWidthPx: width,
          uMaxLength: len,
        });
        gpu.updateInPlace(session.paint, session.release, verts);
        session.ctx.markDirty(expand(boundsOf(verts, 4), 2));
      },
    };
  }

  /** Paint an elongated droplet coloured by bristle `u` of history row `row`. */
  private drop(x: number, y: number, ax: number, ay: number, rAlong: number, rAcross: number, u: number, row: number): void {
    const pad = Math.max(rAlong, rAcross) + 2;
    const verts = rectVertices(x - pad, y - pad, pad * 2, pad * 2);
    this.droplet.setUniforms({
      uRow: row,
      uCenter: [x, y],
      uAxis: [ax, ay],
      uRadii: [Math.max(rAlong, 1), Math.max(rAcross, 1)],
      uU: u,
      uAmount: 0.35,
    });
    this.ctx.gpu.updateInPlace(this.paint, this.droplet, verts);
    this.ctx.markDirty(expand(boundsOf(verts, 4), 2));
  }

  // ---------------------------------------------------------------------------
  // Rendering & snapshots
  // ---------------------------------------------------------------------------

  render(target: GpuTarget, dirty: Rect): void {
    this.composite.setUniforms({ uSrc0: this.paint.textures[0]!, uSrc1: this.paint.textures[1]! });
    this.ctx.gpu.draw(target, this.composite, rectVertices(dirty.x, dirty.y, dirty.w, dirty.h), dirty);
  }

  snapshot(): StyleSnapshot {
    const copy = this.ctx.gpu.createTarget(this.ctx.width, this.ctx.height, {
      attachments: 2,
      format: this.paint.format,
    });
    this.ctx.gpu.copy(this.paint, copy);
    const snap: Snapshot = { target: copy, sim: structuredClone(this.sim), dispose: () => copy.dispose() };
    return snap;
  }

  restore(snapshot: StyleSnapshot): void {
    const snap = snapshot as Snapshot;
    this.ctx.gpu.copy(snap.target, this.paint);
    this.sim = structuredClone(snap.sim);
    this.ctx.markDirty(this.full);
  }

  dispose(): void {
    this.paint.dispose();
    this.back.dispose();
    this.history.dispose();
    [this.inject, this.spread, this.droplet, this.pour, this.pickup, this.deposit, this.release, this.composite].forEach((p) =>
      p.dispose(),
    );
  }
}

function clip(r: Rect, width: number, height: number): Rect {
  const x0 = Math.max(0, Math.floor(r.x));
  const y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(width, Math.ceil(r.x + r.w));
  const y1 = Math.min(height, Math.ceil(r.y + r.h));
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}
