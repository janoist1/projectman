import type { ModuleEntry } from '../module-map';

export const coreMessages: Omit<ModuleEntry, 'paths'> = {
  id: 'core/messages',
  layer: 'core',
  target: 'core/messages',
  pass: 'split',
  sealed: true,
};
