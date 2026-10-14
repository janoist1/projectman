import type { ModuleEntry } from '../module-map';

export const coreBase: ModuleEntry = {
  id: 'core/base',
  layer: 'core',
  target: 'core/base',
  pass: 'split',
  paths: ['core/base/', 'domain/context.ts', 'domain/events.ts', 'domain/event-bus.ts'],
  sealed: true,
};
