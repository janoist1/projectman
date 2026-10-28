import type { ModuleEntry } from '../module-map';

export const coreProjects: Omit<ModuleEntry, 'paths'> = {
  id: 'core/projects',
  layer: 'core',
  target: 'core/projects',
  pass: 'split',
  sealed: true,
};
