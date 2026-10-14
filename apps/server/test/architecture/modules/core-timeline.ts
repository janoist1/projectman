import type { ModuleEntry } from '../module-map';

export const coreTimeline: ModuleEntry = {
  id: 'core/timeline',
  layer: 'core',
  target: 'core/timeline',
  pass: 'move',
  paths: ['core/timeline/'],
  sealed: true,
};
