import type { ModuleEntry } from '../module-map';

export const coreTimeline: Omit<ModuleEntry, 'paths'> = {
  id: 'core/timeline',
  layer: 'core',
  target: 'core/timeline',
  pass: 'move',
  sealed: true,
};
