import type { ModuleEntry } from '../module-map';

export const coreTasks: ModuleEntry = {
  id: 'core/tasks',
  layer: 'core',
  target: 'core/tasks',
  pass: 'split',
  paths: ['core/tasks/'],
  sealed: true,
};
