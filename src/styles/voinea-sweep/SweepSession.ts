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
  type Stamp,
  type StrokeRenderer,
  type StyleSession,
  type StyleSnapshot,
} from '@core/plugin-api';
import { CANVAS, WHITE } from './palettes';
import { DEPOSIT_FS, PICKUP_FS, POUR_FS, RENDER_FS, SPLODGE_FS } from './shaders';

const BRISTLES = 192;

const num = (s: SettingValues, id: string, fallback: number): number => {
  const v = s[id];
  return typeof v === 'number' ? v : fallback;
};

function pickColor(s: SettingValues, rng: Random): [number, number, number] {
  const c = s['color'] as ColorChoice | undefined;
  if (!c || c.colors.length === 0) return hexToRgb('#ff2d55');
  return hexToRgb(c.mode === 'random' ? rng.pick(c.colors) : c.colors[0]!);
}

function expand(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by, w: r.w + 2 * by, h: r.h + 2 * by };
}

/**
 * Canvas model for the Colour Sweep style: two wet-paint layers on the GPU and the
 * three tools of the technique (drop, pour, sweep).
 */
export class SweepSession implements StyleSession {
  private readonly paint: GpuTarget;
  private readonly bristles: [GpuTarget, GpuTarget];
  private readonly splodge: GpuProgram;
  private readonly pour: GpuProgram;
  private readonly pickup: GpuProgram;
  private readonly deposit: GpuProgram;
  private readonly composite: GpuProgram;
  private readonly bg = hexToRgb(CANVAS);
  private readonly white = hexToRgb(WHITE);
  readonly shortSide: number;

  constructor(private readonly ctx: SessionContext) {
    const { gpu, width, height } = ctx;
    const format = gpu.caps.stateFormat;
    this.shortSide = Math.min(width, height);
    this.paint = gpu.createTarget(width, height, { attachments: 2, format });
    this.bristles = [
      gpu.createTarget(BRISTLES, 1, { attachments: 1, format, linear: true }),
      gpu.createTarget(BRISTLES, 1, { attachments: 1, format, linear: true }),
    ];
    this.splodge = gpu.createProgram(SPLODGE_FS);
    this.pour = gpu.createProgram(POUR_FS);
    this.pickup = gpu.createProgram(PICKUP_FS);
    this.deposit = gpu.createProgram(DEPOSIT_FS);
    this.composite = gpu.createProgram(RENDER_FS);
    const size = [width, height];
    this.pickup.setUniforms({ uSize: size, uCount: BRISTLES, uBg: this.bg });
    this.composite.setUniforms({ uSize: size, uBg: this.bg, uGloss: 0.55, uRelief: 26 });
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
    this.ctx.markDirty(this.full);
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
        this.pourAt(0, 0, 0, num(settings, 'thickness', 60) / 100, rng.range(0, 100), true);
        return;
      default:
        throw new Error(`Unknown action "${actionId}"`);
    }
  }

  /** Drop one organic blob. */
  private blob(x: number, y: number, radius: number, color: [number, number, number], amount: number, rng: Random): void {
    const pad = radius * 1.35 + 2;
    const verts = rectVertices(x - pad, y - pad, pad * 2, pad * 2);
    this.splodge.setUniforms({
      uCenter: [x, y],
      uRadius: radius,
      uColor: color,
      uAmount: amount,
      uWobble: 1,
      uPhase: [rng.range(0, 6.283), rng.range(0, 6.283), rng.range(0, 6.283), rng.range(0, 6.283)],
    });
    this.ctx.gpu.updateInPlace(this.paint, this.splodge, verts);
    this.ctx.markDirty(expand(boundsOf(verts, 4), 2));
  }

  private dropStroke(settings: SettingValues, rng: Random): StrokeRenderer {
    const color = pickColor(settings, rng);
    const variation = num(settings, 'variation', 35) / 100;
    const radius = (num(settings, 'size', 9) / 100) * this.shortSide * 0.5 * (1 + rng.range(-0.5, 0.5) * variation);
    const amount = 0.18 + 0.5 * (num(settings, 'thickness', 55) / 100);
    const session = this;
    return {
      spacing: Math.max(1.5, radius * 0.18),
      directionSmoothing: 0,
      stamp(s: Stamp) {
        // First contact drops the full blob; dragging draws a thinner trail of paint.
        const r = s.index === 0 ? radius : radius * (0.38 + 0.12 * rng.next());
        session.blob(s.x, s.y, Math.max(2, r), color, s.index === 0 ? amount : amount * 0.8, rng);
      },
      end() {},
    };
  }

  private scatter(settings: SettingValues, rng: Random): void {
    const { width, height } = this.ctx;
    const count = Math.round(num(settings, 'count', 14));
    const base = (num(settings, 'size', 8) / 100) * this.shortSide * 0.5;
    const amount = 0.18 + 0.5 * (num(settings, 'thickness', 55) / 100);
    const placed: { x: number; y: number; r: number }[] = [];
    for (let i = 0; i < count; i++) {
      let best = { x: width / 2, y: height / 2, r: base };
      // Best-of-N candidate placement: blobs spread out but may touch.
      let bestScore = -Infinity;
      for (let k = 0; k < 12; k++) {
        const r = base * rng.range(0.55, 1.45);
        const c = { x: rng.range(0.1, 0.9) * width, y: rng.range(0.1, 0.9) * height, r };
        let score = Infinity;
        for (const p of placed) score = Math.min(score, Math.hypot(p.x - c.x, p.y - c.y) - (p.r + c.r) * 0.8);
        if (score > bestScore) {
          bestScore = score;
          best = c;
        }
      }
      placed.push(best);
      this.blob(best.x, best.y, best.r, pickColor(settings, rng), amount, rng);
    }
  }

  private pourAt(x: number, y: number, radius: number, thickness: number, seed: number, full = false): void {
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
        session.pourAt(s.x, s.y, radius, thickness, seed);
      },
      end() {},
    };
  }

  private sweepStroke(settings: SettingValues, rng: Random): StrokeRenderer {
    const width = Math.max(4, (num(settings, 'width', 38) / 100) * this.shortSide);
    const smearPx = Math.max(4, (num(settings, 'smear', 35) / 100) * this.shortSide);
    const spacing = Math.min(3, Math.max(1, width * 0.006));
    const margin = Math.max(3, width * 0.03);
    const depth = num(settings, 'depth', 60) / 100;
    const pickup = 1 - Math.exp(-spacing / smearPx);
    const pickupFast = 1 - Math.exp(-spacing / Math.max(3, this.shortSide * 0.02));
    const seed = rng.range(0, 50);
    const gpu = this.ctx.gpu;
    let front = 0;

    // Programs are shared between strokes, so per-stroke uniforms are applied on every stamp
    // (a new stroke may begin while the previous one still has queued stamps).
    const pickupUniforms = {
      uWidthPx: width,
      uDepth: depth,
      uPickup: pickup,
      uPickupFast: pickupFast,
      uStreak: num(settings, 'streaks', 55) / 100,
      uSeed: seed,
    };
    const depositUniforms = {
      uWidthPx: width,
      uDepth: depth,
      uDeposit: num(settings, 'coverage', 85) / 100,
      uStreak: num(settings, 'streaks', 55) / 100,
      uRidge: num(settings, 'ridges', 45) / 100,
      uMargin: margin / width,
      uSeed: seed,
    };

    const session = this;
    return {
      spacing,
      directionSmoothing: width * 0.3,
      stamp(s: Stamp) {
        const pnx = -s.prevDirY, pny = s.prevDirX;
        const cnx = -s.dirY, cny = s.dirX;
        const src = session.bristles[front]!;
        const dst = session.bristles[1 - front]!;
        session.pickup.setUniforms(pickupUniforms);
        session.pickup.setUniforms({
          uSrc0: session.paint.textures[0]!,
          uSrc1: session.paint.textures[1]!,
          uBristle: src.textures[0]!,
          uPrevPos: [s.prevX, s.prevY],
          uCurPos: [s.x, s.y],
          uPrevNormal: [pnx, pny],
          uCurNormal: [cnx, cny],
          uFirst: s.index === 0 ? 1 : 0,
          uDistance: s.distance,
        });
        gpu.draw(dst, session.pickup, rectVertices(0, 0, BRISTLES, 1));
        front = 1 - front;
        if (s.index === 0) return; // first contact only loads the brush

        const h = width / 2 + margin;
        const um = margin / width;
        // Swept quad from the previous brush line to the current one (triangle strip).
        const verts = new Float32Array([
          s.prevX - pnx * h, s.prevY - pny * h, -um, 0,
          s.prevX + pnx * h, s.prevY + pny * h, 1 + um, 0,
          s.x - cnx * h, s.y - cny * h, -um, 1,
          s.x + cnx * h, s.y + cny * h, 1 + um, 1,
        ]);
        session.deposit.setUniforms(depositUniforms);
        session.deposit.setUniforms({ uBristle: dst.textures[0]!, uDistance: s.distance });
        gpu.updateInPlace(session.paint, session.deposit, verts);
        session.ctx.markDirty(expand(boundsOf(verts, 4), 2));
      },
      end() {},
    };
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
    return { target: copy, dispose: () => copy.dispose() } as StyleSnapshot & { target: GpuTarget };
  }

  restore(snapshot: StyleSnapshot): void {
    const target = (snapshot as StyleSnapshot & { target: GpuTarget }).target;
    this.ctx.gpu.copy(target, this.paint);
    this.ctx.markDirty(this.full);
  }

  dispose(): void {
    this.paint.dispose();
    this.bristles.forEach((b) => b.dispose());
    [this.splodge, this.pour, this.pickup, this.deposit, this.composite].forEach((p) => p.dispose());
  }
}
