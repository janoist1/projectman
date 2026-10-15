import type { ModuleEntry } from '../module-map';

export const coreAttachments: Omit<ModuleEntry, 'paths'> = {
  id: 'core/attachments',
  layer: 'core',
  target: 'core/attachments',
  pass: 'move',
  sealed: true,
};
