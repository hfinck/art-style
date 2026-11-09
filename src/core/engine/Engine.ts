import type {
  Rect,
  SettingValues,
  Stamp,
  StrokeRenderer,
  StylePlugin,
  StyleSession,
  StyleSnapshot,
} from '../plugin-api/types';
import { WebGLToolkit } from '../gpu/GpuToolkit';
import { Presenter } from '../gpu/Presenter';
import { RenderTarget } from '../gpu/RenderTarget';
import { GestureRecognizer, type InputPoint } from '../input/GestureRecognizer';
import { PointFilter } from '../input/OneEuroFilter';
import { bindPointerInput } from '../input/PointerInput';
import { StrokeResampler } from '../input/StrokeResampler';
import { ViewTransform } from '../view/ViewTransform';
import { createRandom, randomSeed } from '../util/random';
import { clipToBounds, emptyRect, isEmpty, union } from '../util/rect';
import type { ActionCommand, Command, StrokeCommand } from './Command';
import { History } from './History';
import { simulationSize } from './formats';

export interface ToolSelection {
  toolId: string;
  settings: SettingValues;
}

export interface HistoryState {
  canUndo: boolean;
  canRedo: boolean;
  /** Increments on every change; useful for autosave. */
  revision: number;
}

export interface EngineCallbacks {
  /** Which tool a new stroke should use (null = painting disabled). */
  getTool(): ToolSelection | null;
  onHistory?(state: HistoryState): void;
  /** Long operations (loading, undo replay). progress in 0..1. */
  onBusy?(busy: boolean, progress: number): void;
  onError?(error: Error): void;
}

export interface DeviceProfile {
  pixelBudget: number;
  checkpointInterval: number;
  maxCheckpoints: number;
  maxDpr: number;
}

export function detectDeviceProfile(): DeviceProfile {
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
  if (coarse || memory <= 4) {
    return { pixelBudget: 2_000_000, checkpointInterval: 8, maxCheckpoints: 3, maxDpr: 2 };
  }
  return { pixelBudget: 4_000_000, checkpointInterval: 8, maxCheckpoints: 6, maxDpr: 2 };
}

interface StrokeJob {
  cmd: StrokeCommand;
  renderer: StrokeRenderer;
  resampler: StrokeResampler;
  queue: Stamp[];
  qi: number;
  ended: boolean;
  /** Raw normalised points (converted to Float32Array on commit). */
  points: number[];
}

/**
 * The painting engine: owns the GL context, the active style session, input,
 * history and the render loop. It knows nothing about any particular style.
 */
export class Engine {
  readonly view = new ViewTransform();
  private gpu!: WebGLToolkit;
  private presenter!: Presenter;
  private display!: RenderTarget;
  private session!: StyleSession;
  private plugin!: StylePlugin;
  private history: History<StyleSnapshot>;
  private readonly gl: WebGL2RenderingContext;
  private readonly recognizer: GestureRecognizer;
  private readonly unbindInput: () => void;
  private readonly resizeObserver: ResizeObserver;
  private readonly filter = new PointFilter();

  width = 0;
  height = 0;
  private dirty: Rect = emptyRect();
  private needsPresent = true;
  private frameRequested = false;
  private jobs: StrokeJob[] = [];
  private live: StrokeJob | null = null;
  private stampsPerFrame = 600;
  private lastFrame = 0;
  private viewW = 1;
  private viewH = 1;
  private cssW = 1;
  private cssH = 1;
  private dpr = 1;
  private autoFit = true;
  private busy = false;
  private revision = 0;
  private contextLost = false;
  private disposed = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly callbacks: EngineCallbacks,
    private readonly profile: DeviceProfile = detectDeviceProfile(),
  ) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
      desynchronized: true, // lower input-to-photon latency where supported
    } as WebGLContextAttributes);
    if (!gl) throw new Error('WebGL2 is not available on this device.');
    this.gl = gl;
    this.gpu = new WebGLToolkit(gl);
    this.presenter = new Presenter(this.gpu);
    this.history = new History(profile.checkpointInterval, profile.maxCheckpoints);

    this.recognizer = new GestureRecognizer({
      strokeStart: (p) => this.strokeStart(p),
      strokeMove: (pts) => this.strokeMove(pts),
      strokeEnd: () => this.strokeEnd(),
      strokeCancel: () => this.strokeCancel(),
      viewChange: (a, b) => {
        this.autoFit = false;
        this.view.applyTwoPoint(a[0], a[1], b[0], b[1]);
        this.requestPresent();
      },
      gestureEnd: () => {
        this.view.snapRotation({ x: this.cssW / 2, y: this.cssH / 2 });
        this.requestPresent();
      },
      tap: (n) => {
        if (n === 2) void this.undo();
        else if (n === 3) void this.redo();
      },
    });
    this.unbindInput = bindPointerInput(canvas, this.recognizer, {
      onWheel: (x, y, dy, pinch) => {
        this.autoFit = false;
        this.view.zoomAt(x, y, Math.exp(-dy * (pinch ? 0.01 : 0.0015)));
        this.requestPresent();
      },
    });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored);
    this.resize();
  }

  // -------------------------------------------------------------------------
  // Document lifecycle
  // -------------------------------------------------------------------------

  /** Start a document with the given style and format, replaying `commands`. */
  async open(plugin: StylePlugin, ratio: number, commands: Command[] = []): Promise<void> {
    this.cancelAllStrokes();
    this.history.clear();
    this.session?.dispose();
    this.display?.dispose();
    this.plugin = plugin;
    const size = simulationSize(ratio, this.profile.pixelBudget, this.gpu.caps.maxTextureSize);
    this.width = size.width;
    this.height = size.height;
    this.createSession();
    this.autoFit = true;
    this.fitView();
    this.history.load(commands);
    this.history.setCursor(0);
    await this.replayTo(commands.length);
    this.emitHistory();
  }

  private createSession(): void {
    this.display = this.gpu.createTarget(this.width, this.height, { attachments: 1, format: 'rgba8', mipmaps: true });
    this.session = this.plugin.createSession({
      gpu: this.gpu,
      width: this.width,
      height: this.height,
      markDirty: (r) => this.markDirty(r),
    });
    this.session.reset();
    this.markDirty({ x: 0, y: 0, w: this.width, h: this.height });
  }

  /** Commands currently applied (what should be saved). */
  commands(): Command[] {
    return this.history.applied();
  }

  get isBusy(): boolean {
    return this.busy;
  }

  // -------------------------------------------------------------------------
  // Strokes
  // -------------------------------------------------------------------------

  private toCanvas(p: InputPoint): [number, number] {
    const [fx, fy] = this.filter.filter(p.x, p.y, p.t);
    const c = this.view.toCanvas(fx, fy);
    return [c.x, c.y];
  }

  private strokeStart(p: InputPoint): void {
    if (this.busy || this.contextLost || !this.session) return;
    const tool = this.callbacks.getTool();
    if (!tool) return;
    this.filter.reset();
    const seed = randomSeed();
    const settings = structuredClone(tool.settings);
    const renderer = this.session.beginStroke(tool.toolId, settings, createRandom(seed));
    const job: StrokeJob = {
      cmd: { kind: 'stroke', tool: tool.toolId, settings, seed, points: new Float32Array(0) },
      renderer,
      resampler: null!,
      queue: [],
      qi: 0,
      ended: false,
      points: [],
    };
    job.resampler = new StrokeResampler(renderer.spacing, renderer.directionSmoothing, (s) => job.queue.push(s));
    this.live = job;
    this.jobs.push(job);
    this.addPoint(job, p);
    this.requestFrame();
  }

  private addPoint(job: StrokeJob, p: InputPoint): void {
    const [x, y] = this.toCanvas(p);
    // Quantise exactly as stored so live rendering and replay are bit-identical.
    const nx = Math.fround(x / this.width);
    const ny = Math.fround(y / this.height);
    job.points.push(nx, ny);
    job.resampler.add(nx * this.width, ny * this.height);
  }

  private strokeMove(points: InputPoint[]): void {
    const job = this.live;
    if (!job) return;
    for (const p of points) this.addPoint(job, p);
    this.requestFrame();
  }

  private strokeEnd(): void {
    const job = this.live;
    if (!job) return;
    this.live = null;
    job.resampler.finish();
    job.ended = true;
    job.cmd.points = new Float32Array(job.points);
    this.requestFrame();
  }

  private strokeCancel(): void {
    const job = this.live;
    if (!job) return;
    this.live = null;
    this.jobs = this.jobs.filter((j) => j !== job);
    // Finish strokes queued before it, then rebuild the canvas without the cancelled one.
    this.drain();
    void this.replayTo(this.history.cursor);
  }

  private cancelAllStrokes(): void {
    this.live = null;
    this.jobs = [];
  }

  /** Apply up to `budget` stamps from queued strokes. Returns how many were applied. */
  private process(budget: number): number {
    let n = 0;
    while (this.jobs.length > 0 && n < budget) {
      const job = this.jobs[0]!;
      while (job.qi < job.queue.length && n < budget) {
        job.renderer.stamp(job.queue[job.qi++]!);
        n++;
      }
      if (job.qi < job.queue.length) break;
      job.queue.length = 0;
      job.qi = 0;
      if (!job.ended) break;
      job.renderer.end();
      this.jobs.shift();
      this.commit(job.cmd);
    }
    return n;
  }

  /** Synchronously finish every queued stroke. */
  private drain(): void {
    this.process(Infinity);
  }

  private commit(cmd: Command): void {
    if (this.history.push(cmd)) this.history.addCheckpoint(this.session.snapshot());
    this.emitHistory();
  }

  // -------------------------------------------------------------------------
  // Actions, undo, redo
  // -------------------------------------------------------------------------

  runAction(actionId: string, settings: SettingValues): void {
    if (this.busy || !this.session) return;
    this.drain();
    const cmd: ActionCommand = { kind: 'action', action: actionId, settings: structuredClone(settings), seed: randomSeed() };
    this.apply(cmd);
    this.commit(cmd);
    this.requestFrame();
  }

  get canUndo(): boolean {
    return this.history.canUndo;
  }
  get canRedo(): boolean {
    return this.history.canRedo;
  }

  async undo(): Promise<void> {
    if (this.busy || this.live) return;
    this.drain();
    if (!this.history.canUndo) return;
    await this.replayTo(this.history.cursor - 1);
    this.emitHistory();
  }

  async redo(): Promise<void> {
    if (this.busy || this.live) return;
    this.drain();
    const cmd = this.history.commandAt(this.history.cursor);
    if (!cmd) return;
    this.apply(cmd);
    this.history.setCursor(this.history.cursor + 1);
    if (this.history.checkpointDue()) this.history.addCheckpoint(this.session.snapshot());
    this.emitHistory();
    this.requestFrame();
  }

  /** Clear the painting (undoable). */
  clearAll(): void {
    this.runAction('__clear__', {});
  }

  /** Apply one command synchronously. Returns the amount of work done (stamps). */
  private apply(cmd: Command): number {
    if (cmd.kind === 'action') {
      if (cmd.action === '__clear__') {
        this.session.reset();
      } else {
        this.session.runAction(cmd.action, cmd.settings, createRandom(cmd.seed));
      }
      return 500;
    }
    const renderer = this.session.beginStroke(cmd.tool, cmd.settings, createRandom(cmd.seed));
    let count = 0;
    const resampler = new StrokeResampler(renderer.spacing, renderer.directionSmoothing, (s) => {
      renderer.stamp(s);
      count++;
    });
    const pts = cmd.points;
    for (let i = 0; i + 1 < pts.length; i += 2) resampler.add(pts[i]! * this.width, pts[i + 1]! * this.height);
    resampler.finish();
    renderer.end();
    return count;
  }

  /** Bring the canvas to the state after `target` commands, using checkpoints. */
  private async replayTo(target: number): Promise<void> {
    const plan = this.history.plan(target);
    if (plan.checkpoint) this.session.restore(plan.checkpoint);
    else this.session.reset();
    this.history.setCursor(plan.from);
    this.markDirty({ x: 0, y: 0, w: this.width, h: this.height });
    if (plan.replay.length === 0) {
      this.requestFrame();
      return;
    }
    this.setBusy(true, 0);
    try {
      const budget = 6000;
      let work = 0;
      for (let i = 0; i < plan.replay.length; i++) {
        work += this.apply(plan.replay[i]!);
        this.history.setCursor(plan.from + i + 1);
        if (this.history.checkpointDue()) this.history.addCheckpoint(this.session.snapshot());
        if (work >= budget && i < plan.replay.length - 1) {
          work = 0;
          this.callbacks.onBusy?.(true, (i + 1) / plan.replay.length);
          this.renderNow();
          await nextFrame();
          if (this.disposed || this.contextLost) return;
        }
      }
    } finally {
      this.setBusy(false, 1);
    }
    this.requestFrame();
  }

  private setBusy(busy: boolean, progress: number): void {
    this.busy = busy;
    if (busy) this.recognizer.reset();
    this.callbacks.onBusy?.(busy, progress);
  }

  private emitHistory(): void {
    this.revision++;
    this.callbacks.onHistory?.({ canUndo: this.history.canUndo, canRedo: this.history.canRedo, revision: this.revision });
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private markDirty(r: Rect): void {
    this.dirty = union(this.dirty, r);
    this.requestFrame();
  }

  private requestPresent(): void {
    this.needsPresent = true;
    this.requestFrame();
  }

  private requestFrame(): void {
    if (this.frameRequested || this.disposed) return;
    this.frameRequested = true;
    requestAnimationFrame(this.frame);
  }

  private readonly frame = (now: number): void => {
    this.frameRequested = false;
    if (this.disposed || this.contextLost || !this.session) return;
    const dt = this.lastFrame ? now - this.lastFrame : 16;
    this.lastFrame = now;
    // Adapt the per-frame stamp budget to keep the UI at ~60 fps without dropping input.
    if (dt > 24) this.stampsPerFrame = Math.max(80, this.stampsPerFrame * 0.85);
    else if (dt < 19) this.stampsPerFrame = Math.min(6000, this.stampsPerFrame * 1.08);
    try {
      this.process(Math.round(this.stampsPerFrame));
      this.renderNow();
    } catch (e) {
      this.callbacks.onError?.(e as Error);
    }
    const pending = this.jobs.some((j) => j.qi < j.queue.length || j.ended);
    if (pending) this.requestFrame();
    else this.lastFrame = 0;
  };

  private renderNow(): void {
    const area = clipToBounds(this.dirty, this.width, this.height);
    this.dirty = emptyRect();
    if (!isEmpty(area)) {
      this.session.render(this.display, area);
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.display.textures[0]!);
      gl.generateMipmap(gl.TEXTURE_2D);
      this.needsPresent = true;
    }
    if (this.needsPresent) {
      this.needsPresent = false;
      this.presenter.draw(this.display, this.view, this.viewW, this.viewH, this.dpr);
    }
  }

  // -------------------------------------------------------------------------
  // View
  // -------------------------------------------------------------------------

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.cssW = Math.max(1, rect.width);
    this.cssH = Math.max(1, rect.height);
    this.dpr = Math.min(window.devicePixelRatio || 1, this.profile.maxDpr);
    this.viewW = Math.max(1, Math.round(this.cssW * this.dpr));
    this.viewH = Math.max(1, Math.round(this.cssH * this.dpr));
    if (this.canvas.width !== this.viewW) this.canvas.width = this.viewW;
    if (this.canvas.height !== this.viewH) this.canvas.height = this.viewH;
    if (this.autoFit && this.width > 0) this.view.fit(this.width, this.height, this.cssW, this.cssH);
    this.requestPresent();
  }

  fitView(): void {
    this.autoFit = true;
    if (this.width > 0) this.view.fit(this.width, this.height, this.cssW, this.cssH);
    this.requestPresent();
  }

  // -------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------

  /** Read the finished painting at simulation resolution. */
  readImage(): ImageData {
    this.drain();
    this.markDirty({ x: 0, y: 0, w: this.width, h: this.height });
    this.renderNow();
    const gl = this.gl;
    const pixels = new Uint8ClampedArray(this.width * this.height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.display.framebuffer);
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // Texture row 0 is image row 0 (top), matching ImageData: no flip needed.
    return new ImageData(pixels, this.width, this.height);
  }

  // -------------------------------------------------------------------------
  // Context loss (common on mobile when the app is backgrounded)
  // -------------------------------------------------------------------------

  private readonly onContextLost = (e: Event): void => {
    e.preventDefault();
    this.contextLost = true;
    this.cancelAllStrokes();
    this.recognizer.reset();
    this.callbacks.onBusy?.(true, 0);
  };

  private readonly onContextRestored = (): void => {
    this.contextLost = false;
    const commands = this.history.applied();
    // All GPU objects are gone: rebuild from scratch and replay the command log.
    this.gpu = new WebGLToolkit(this.gl);
    this.presenter = new Presenter(this.gpu);
    this.history = new History(this.profile.checkpointInterval, this.profile.maxCheckpoints);
    if (!this.plugin) return;
    this.createSession();
    this.history.load(commands);
    this.history.setCursor(0);
    void this.replayTo(commands.length).then(() => this.emitHistory());
  };

  dispose(): void {
    this.disposed = true;
    this.unbindInput();
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.history.clear();
    this.session?.dispose();
    this.display?.dispose();
    this.gpu.dispose();
  }
}

function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}
