import type { SettingValues } from '../plugin-api/types';

interface CommandBase {
  settings: SettingValues;
  seed: number;
  /** Simulation ticks that ran between the previous command and this one. */
  ticksBefore?: number;
}

/**
 * A stroke: the filtered input path in normalised canvas coordinates.
 * `stride` 3 = (x/width, y/height, ms since stroke start); older projects use stride 2 (no time).
 */
export interface StrokeCommand extends CommandBase {
  kind: 'stroke';
  tool: string;
  points: Float32Array;
  stride?: 2 | 3;
  /** For each simulation tick during the stroke: how many stamps had been applied. */
  ticks?: Uint32Array;
}

export interface ActionCommand extends CommandBase {
  kind: 'action';
  action: string;
}

export type Command = StrokeCommand | ActionCommand;

export interface ProjectData {
  id: string;
  name: string;
  styleId: string;
  formatId: string;
  createdAt: number;
  updatedAt: number;
  commands: Command[];
}
