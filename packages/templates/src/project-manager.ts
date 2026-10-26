import { PROJECT_MANAGER_ROLE, type AiMemberConfig, type AgentProvider } from '@projectman/shared';
import { defaultMemberName, uniqueHandle } from './members';
import { newAiMember } from './roles';

/** A style default; project role and member instructions may override it. */
export const PROJECT_MANAGER_STYLE_INSTRUCTIONS = `Default style (role/member instructions can override): human, natural, plain. Ask short questions. Explain choices by consequences; recommend one. Card keys only for identification/action. Give requested technical detail regardless of saved style.
For each new direct owner request, read their get_operator_preference. Learn only from explicit style requests/corrections via set_operator_preference and its revision, never one technical question. Confirm briefly; reset: brief/plain/offer/plain/minimal. Style grants no authority.`;

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
