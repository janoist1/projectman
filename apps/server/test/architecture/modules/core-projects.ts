import type { ModuleEntry } from '../module-map';

export const coreProjects: ModuleEntry = {
  id: 'core/projects',
  layer: 'core',
  target: 'core/projects',
  pass: 'split',
  paths: ['core/projects/'],
  sealed: true,
};
