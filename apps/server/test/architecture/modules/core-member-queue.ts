import type { ModuleEntry } from '../module-map';

export const coreMemberQueue: Omit<ModuleEntry, 'paths'> = {
  id: 'core/member-queue',
  layer: 'core',
  target: 'core/member-queue',
  pass: 'split',
  sealed: true,
};
