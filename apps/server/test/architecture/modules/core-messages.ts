import type { ModuleEntry } from '../module-map';

export const coreMessages: ModuleEntry = {
  id: 'core/messages',
  layer: 'core',
  target: 'core/messages',
  pass: 'split',
  paths: ['core/messages/', 'domain/messaging/'],
  sealed: true,
};
