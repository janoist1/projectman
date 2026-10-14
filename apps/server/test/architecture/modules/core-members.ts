import type { ModuleEntry } from '../module-map';

export const coreMembers: ModuleEntry = {
  id: 'core/members',
  layer: 'core',
  target: 'core/members',
  pass: 'split',
  paths: ['core/members/'],
  sealed: true,
};
