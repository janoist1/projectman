import type { ModuleEntry } from '../module-map';

export const coreProjects: ModuleEntry = {
  id: 'core/projects',
  layer: 'core',
  target: 'core/projects',
  pass: 'split',
  paths: [
    'core/projects/',
    'domain/projects.ts',
    'domain/roles.ts',
    'domain/stage-reviewers.ts',
    'domain/visibility.ts',
  ],
  sealed: true,
};
