import { OPERATOR_ROLE, type AiMemberConfig } from '@projectman/shared';
import { defaultMemberName, uniqueHandle } from './members';
import { newAiMember } from './roles';

/**
 * The Operator every project has (PM-447): handle `operator` (`operator-2`, ... when taken), the
 * role's name in the project's language, and the starting values of any new AI member (the same
 * provider, model and permission mode as the project manager's).
 */
export function operatorMember(input: {
  language: string;
  sponsor: string;
  taken: readonly string[];
}): AiMemberConfig {
  return newAiMember({
    role: OPERATOR_ROLE,
    handle: uniqueHandle('operator', new Set(input.taken)),
    displayName: defaultMemberName(OPERATOR_ROLE, input.language, 1),
    sponsor: input.sponsor,
  });
}
