import type { ModuleEntry } from '../module-map';

export const coreMembers: Omit<ModuleEntry, 'paths'> = {
  id: 'core/members',
  layer: 'core',
  target: 'core/members',
  pass: 'split',
  sealed: true,
};
