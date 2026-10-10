import type { Actor } from '../domain/event';
import type { MemberHandle } from '../domain/member';
import { isOnLeave } from './leave';
import { memberOf } from './lookup';
import type { AiMemberConfig, MemberConfig, ProjectConfig } from './schema';

// Kept apart from operator.ts, which pulls in the integrator and owner-only rules: domain/task.ts needs
// only these, and importing the rules there would close an import cycle through the event schema.

/** The built-in role of the Operator, the AI the owner talks to about how the project runs (PM-447). */
export const OPERATOR_ROLE = 'ai_operator';

/** An AI member holding the built-in ai_operator role; a temp worker never counts, leave does not matter. */
export function isOperator(
  member: { kind: MemberConfig['kind']; role?: string; temp?: boolean } | null | undefined,
): boolean {
  return member?.kind === 'ai' && member.role === OPERATOR_ROLE && member.temp !== true;
}

function operatorsOf(config: Pick<ProjectConfig, 'team'>): AiMemberConfig[] {
  return config.team.members.filter((m): m is AiMemberConfig => isOperator(m));
}

/** The team's Operator: the first not on leave, else the first; null when there is none. */
export function operatorOf(config: Pick<ProjectConfig, 'team'>): AiMemberConfig | null {
  const operators = operatorsOf(config);
  return operators.find((m) => !isOnLeave(m)) ?? operators[0] ?? null;
}

/** Whether `handle` is the team's only Operator: it cannot be retired (nor sent on leave, PM-473). */
export function isRequiredOperator(config: Pick<ProjectConfig, 'team'>, handle: MemberHandle): boolean {
  const operators = operatorsOf(config);
  return operators.length === 1 && operators[0]!.handle === handle;
}

/**
 * Whether the actor is the Operator at work: an AI member holding the role, not acting through the
 * integrator key. A person, the system or another AI member never is.
 */
export function isOperatorActor(
  config: Pick<ProjectConfig, 'team'>,
  actor: Pick<Actor, 'kind' | 'handle' | 'via'>,
): boolean {
  return actor.kind === 'ai' && !actor.via && isOperator(memberOf(config, actor.handle));
}
