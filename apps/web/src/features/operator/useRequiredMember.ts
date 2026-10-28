import { isRequiredProjectManager } from '@projectman/shared';
import { useConfig } from '../../api/queries';
import { useProject } from '../../app/contexts';

/**
 * Whether this member is the project's only AI project manager: it cannot be retired (PM-429).
 * Only a viewer who manages the team reads the configuration for it (the chip is a hint for them).
 */
export function useIsRequiredPm(handle: string): boolean {
  const { key, can } = useProject();
  const config = useConfig(key, can.manageTeam);
  return config.data ? isRequiredProjectManager(config.data.config, handle) : false;
}
