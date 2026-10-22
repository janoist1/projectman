import type { HistoryViewer } from '@projectman/shared';
import type { ProjectConfig } from '@projectman/shared';
import { createDomainHarness, OWNER_ACTOR } from './domain-harness';
import type { DomainHarness } from './domain-harness';

/** Fictional humans added to the test project next to its owner: one of each access level, two clients. */
const HUMANS = [
  { handle: 'admin', access: 'admin' },
  { handle: 'dev', access: 'developer' },
  { handle: 'reader', access: 'viewer' },
  { handle: 'acme', access: 'client' },
  { handle: 'beta', access: 'client' },
] as const;

/** A viewer by handle; the service recomputes the access from the roster, so the access here is a placeholder. */
export const as = (handle: string): HistoryViewer => ({ handle, access: 'viewer' });

function addHumans(config: ProjectConfig): void {
  for (const human of HUMANS)
    config.team.members.push({
      kind: 'human',
      handle: human.handle,
      displayName: human.handle,
      email: `${human.handle}@example.test`,
      access: human.access,
      roles: [],
    });
}

export const historyHarness = (
  opts: Parameters<typeof createDomainHarness>[0] = {},
): Promise<DomainHarness> =>
  createDomainHarness({
    ...opts,
    adjust: (config) => {
      addHumans(config);
      opts.adjust?.(config);
    },
  });

export { OWNER_ACTOR };
