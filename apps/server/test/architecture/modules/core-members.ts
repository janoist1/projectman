import type { ModuleEntry } from '../module-map';

export const coreMembers: ModuleEntry = {
  id: 'core/members',
  layer: 'core',
  target: 'core/members',
  pass: 'split',
  paths: [
    'core/members/ports.ts',
    'domain/members.ts',
    'domain/access.ts',
    'domain/invitations.ts',
    'domain/presence.ts',
    'domain/naming.ts',
  ],
  sealed: false,
};
