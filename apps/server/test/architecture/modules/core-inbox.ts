import type { ModuleEntry } from '../module-map';

export const coreInbox: ModuleEntry = {
  id: 'core/inbox',
  layer: 'core',
  target: 'core/inbox',
  pass: 'split',
  paths: ['core/inbox/'],
  sealed: true,
};
