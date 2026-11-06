import type { ModuleEntry } from '../module-map';

export const coreDocuments: Omit<ModuleEntry, 'paths'> = {
  id: 'core/documents',
  layer: 'core',
  target: 'core/documents',
  pass: 'move',
  sealed: true,
};
