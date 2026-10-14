import type { ModuleEntry } from '../module-map';

export const coreBase: ModuleEntry = {
  id: 'core/base',
  layer: 'core',
  target: 'core/base',
  pass: 'split',
  paths: ['core/base/'],
  sealed: true,
};
