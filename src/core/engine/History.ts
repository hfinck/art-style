import type { Command } from './Command';

export interface Disposable {
  dispose(): void;
}

/**
 * Linear command history with sparse checkpoints.
 *
 * `cursor` = number of commands currently applied. Undo restores the nearest
 * checkpoint at or before the target and replays the commands after it.
 */
export class History<S extends Disposable> {
  private commands: Command[] = [];
  private _cursor = 0;
  /** Checkpoints keyed by the cursor value at which they were taken. */
  private readonly checkpoints = new Map<number, S>();

  constructor(
    readonly checkpointInterval: number,
    readonly maxCheckpoints: number,
  ) {}

  get cursor(): number {
    return this._cursor;
  }
  get length(): number {
    return this.commands.length;
  }
  get canUndo(): boolean {
    return this._cursor > 0;
  }
  get canRedo(): boolean {
    return this._cursor < this.commands.length;
  }

  /** Commands that are currently applied. */
  applied(): Command[] {
    return this.commands.slice(0, this._cursor);
  }

  load(commands: Command[]): void {
    this.clear();
    this.commands = [...commands];
    this._cursor = this.commands.length;
  }

  /** Record a new command; drops the redo tail. Returns true if a checkpoint is due. */
  push(cmd: Command): boolean {
    if (this._cursor < this.commands.length) {
      this.commands.length = this._cursor;
      for (const [k, s] of this.checkpoints) {
        if (k > this._cursor) {
          s.dispose();
          this.checkpoints.delete(k);
        }
      }
    }
    this.commands.push(cmd);
    this._cursor++;
    return this.checkpointDue();
  }

  checkpointDue(): boolean {
    return this._cursor > 0 && this._cursor % this.checkpointInterval === 0 && !this.checkpoints.has(this._cursor);
  }

  addCheckpoint(snapshot: S): void {
    this.checkpoints.set(this._cursor, snapshot);
    while (this.checkpoints.size > this.maxCheckpoints) {
      // Evict the oldest; recent ones matter most for undo speed.
      const oldest = Math.min(...this.checkpoints.keys());
      this.checkpoints.get(oldest)!.dispose();
      this.checkpoints.delete(oldest);
    }
  }

  /**
   * Plan how to reach `target`: which checkpoint to restore (null = start from blank)
   * and which commands to replay afterwards.
   */
  plan(target: number): { checkpoint: S | null; from: number; replay: Command[] } {
    let best = -1;
    for (const k of this.checkpoints.keys()) if (k <= target && k > best) best = k;
    const from = Math.max(0, best);
    return {
      checkpoint: best >= 0 ? this.checkpoints.get(best)! : null,
      from,
      replay: this.commands.slice(from, target),
    };
  }

  setCursor(c: number): void {
    this._cursor = Math.max(0, Math.min(this.commands.length, c));
  }

  commandAt(i: number): Command | undefined {
    return this.commands[i];
  }

  clear(): void {
    for (const s of this.checkpoints.values()) s.dispose();
    this.checkpoints.clear();
    this.commands = [];
    this._cursor = 0;
  }
}
