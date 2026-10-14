import type { ModuleEntry } from '../module-map';

export const coreTasks: ModuleEntry = {
  id: 'core/tasks',
  layer: 'core',
  target: 'core/tasks',
  pass: 'split',
  paths: [
    'domain/tasks/',
    'domain/board.ts',
    'domain/project-focus.ts',
    'domain/involvements.ts',
    'domain/card-measure.ts',
  ],
  sealed: false,
};
