import type { ModuleEntry } from '../module-map';

export const coreBase: Omit<ModuleEntry, 'paths'> = {
  id: 'core/base',
  layer: 'core',
  target: 'core/base',
  pass: 'split',
  sealed: true,
};
