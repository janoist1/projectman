import { PROJECT_MANAGER_ROLE, type AiMemberConfig, type AgentProvider } from '@projectman/shared';
import { defaultMemberName, uniqueHandle } from './members';
import { newAiMember } from './roles';

/**
 * The project manager every project requires (PM-429): handle `pm` (`pm-2`, ... when taken), the
 * role's name in the project's language, and the starting values of any new AI member.
 */
export function projectManagerMember(input: {
  provider?: AgentProvider | undefined;
  language: string;
  sponsor: string;
  taken: readonly string[];
}): AiMemberConfig {
  return newAiMember({
    provider: input.provider,
    role: PROJECT_MANAGER_ROLE,
    handle: uniqueHandle('pm', new Set(input.taken)),
    displayName: defaultMemberName(PROJECT_MANAGER_ROLE, input.language, 1),
    sponsor: input.sponsor,
  });
}
