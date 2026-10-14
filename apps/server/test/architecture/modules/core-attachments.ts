import type { ModuleEntry } from '../module-map';

export const coreAttachments: ModuleEntry = {
  id: 'core/attachments',
  layer: 'core',
  target: 'core/attachments',
  pass: 'move',
  paths: ['core/attachments/', 'domain/attachments/', 'domain/message-attachments/'],
  sealed: true,
};
