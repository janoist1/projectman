import type { ModuleEntry } from '../module-map';

export const coreTasks: Omit<ModuleEntry, 'paths'> = {
  id: 'core/tasks',
  layer: 'core',
  target: 'core/tasks',
  pass: 'split',
  sealed: true,
};
