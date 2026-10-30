import { boundaryLeads } from '../domain/permission-delegation';
import { memberDuties } from './duties';
import { memberOf } from './lookup';
import type { ProjectConfig } from './schema';

/**
 * The AI member who decides, in the owners' stead, what a member asked a person but the owners need not
 * decide (PM-1134): a technical or professional choice the screening forwards, and a machine step no
 * integrator can take. The first AI member of `boundaryLeads(config, asker)` (holds boundary_authorization,
 * not the project manager, not the asker, not on leave, the AI team on), in the team's order. Null when
 * there is none, or when `asker` holds boundary_authorization itself: a decider's own question goes to the
 * owners, so two deciders never pass a question back and forth. Independent of `team.boundary.enabled`,
 * which only delegates permission requests.
 */
export function technicalDeciderOf(config: ProjectConfig, asker: string): string | null {
  const askerMember = memberOf(config, asker);
  if (askerMember && memberDuties(config, askerMember).includes('boundary_authorization')) return null;
  return boundaryLeads(config, asker).find((handle) => memberOf(config, handle)?.kind === 'ai') ?? null;
}
