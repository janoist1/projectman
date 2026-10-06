import { canManageInstancePause } from './pause';

/** Provider keys have the same installation-wide ownership rule as pausing the instance. */
export function canManageProviderKeys(accesses: Parameters<typeof canManageInstancePause>[0]): boolean {
  return canManageInstancePause(accesses);
}
