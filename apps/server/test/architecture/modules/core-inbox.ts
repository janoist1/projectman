import type { ModuleEntry } from '../module-map';

export const coreInbox: Omit<ModuleEntry, 'paths'> = {
  id: 'core/inbox',
  layer: 'core',
  target: 'core/inbox',
  pass: 'split',
  sealed: true,
};
