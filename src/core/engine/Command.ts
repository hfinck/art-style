import type { SettingValues } from '../plugin-api/types';

/** A stroke: the filtered input path in normalised canvas coordinates (x/width, y/height). */
export interface StrokeCommand {
  kind: 'stroke';
  tool: string;
  settings: SettingValues;
  seed: number;
  points: Float32Array;
}

export interface ActionCommand {
  kind: 'action';
  action: string;
  settings: SettingValues;
  seed: number;
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
