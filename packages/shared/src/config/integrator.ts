import { z } from 'zod';
import type { LabelDefinition } from '../domain/label';
import { canonical } from './canonical';
import { isOwnerApprovalLabel, labelHolders } from './labels';
import { ownerOnlyChanges } from './owner-only';
import { DEFAULT_MAX_FIX_ROUNDS } from './schema';
import type { ProjectConfig } from './schema';
import { operatorOf } from './operator-member';

export type SuperAccessVerdict =
  | { allowed: true }
  | {
      allowed: false;
      code:
        'integrator_read_only' | 'owner_approval_required' | 'insufficient_access' | 'integrator_not_allowed';
    };

/** Credential policy, independent of HTTP verbs. Domain operations classify reads and decisions (PM-759). */
export function superAccessVerdict(
  config: ProjectConfig,
  facts: {
    mode: 'super' | 'read';
    operation: 'read' | 'write' | 'approval' | 'key_management';
    ownerMembership: boolean;
  },
): SuperAccessVerdict {
  if (facts.mode === 'read' && facts.operation !== 'read')
    return { allowed: false, code: 'integrator_read_only' };
  if (facts.operation === 'key_management') return { allowed: false, code: 'integrator_not_allowed' };
  // The super key decides approvals in the Operator's own name (PM-870).
  if (facts.operation === 'approval' && facts.mode !== 'super')
    return { allowed: false, code: 'owner_approval_required' };
  if (!facts.ownerMembership) return { allowed: false, code: 'insufficient_access' };
  if (facts.mode === 'super' && !operatorOf(config))
    return { allowed: false, code: 'integrator_not_allowed' };
  return { allowed: true };
}

/**
 * Who may hold an integrator key (PM-1063): the host owner and an active owner account, each with a password
 * (a passwordless, e-mail-login account never does, PM-670). The scope of a key is its holder's own projects.
 * Extend the circle here and nowhere else.
 */
export function canHoldIntegratorKey(input: {
  hostOwner: boolean;
  ownerAccount: boolean;
  hasPassword: boolean;
}): boolean {
  return input.hasPassword && (input.hostOwner || input.ownerAccount);
}

/**
 * Whether an integrator key of `holder` reaches a project at all (PM-1063). The project's team is editable by
 * its owners, so the key's reach also rests on a fact the team cannot write: who created the project. A
 * project an owner account created (`createdBy` is that account, not the host owner) is reached by the
 * creator's key only, whoever else the team lists as an owner; any other project (registered by the host
 * owner, `createdBy` null or the host) stays with the owner members' keys. The caller still checks the
 * owner membership.
 */
export function integratorKeyCoversProject(input: {
  createdBy: string | null;
  creatorIsHost: boolean;
  holder: string;
}): boolean {
  return input.createdBy === null || input.creatorIsHost || input.createdBy === input.holder;
}

/** What the integrator key may not change (PM-418), in the order integratorConfigRefusal checks them. */
export const IntegratorRefusal = z.enum([
  'approval_rules',
  'owner_settings',
  'members',
  'invitations',
  'engines',
  'system_feedback',
]);
export type IntegratorRefusal = z.infer<typeof IntegratorRefusal>;

/**
 * Why an integrator configuration change may not commit `next` over `previous`, or null when it may. Compares the
 * end result, so PUT, PATCH, roles, members and revert are decided alike. Never 'invitations'.
 *
 * These restrictions also classify configuration effects for the Operator's mutation policy.
 */
export function integratorConfigRefusal(
  previous: ProjectConfig,
  next: ProjectConfig,
): IntegratorRefusal | null {
  if (approvalRulesChanged(previous, next)) return 'approval_rules';
  if (ownerSettingsChanged(previous, next)) return 'owner_settings';
  if (membersChanged(previous, next)) return 'members';
  return null;
}

function approvalRulesChanged(previous: ProjectConfig, next: ProjectConfig): boolean {
  // A label is protected when it is an approval in the old or in the new configuration, so one
  // cannot leave the circle first and be changed after, nor slip in as a new one.
  const protectedIds = new Set<string>();
  for (const config of [previous, next])
    for (const label of config.pipeline.labels)
      if (isOwnerApprovalLabel(config, label)) protectedIds.add(label.id);
  for (const id of protectedIds) {
    const before = previous.pipeline.labels.find((label) => label.id === id);
    const after = next.pipeline.labels.find((label) => label.id === id);
    if (labelRule(before) !== labelRule(after)) return true;
    if (before && after) {
      const holders = (config: ProjectConfig, label: LabelDefinition) =>
        labelHolders(config, label).sort().join(',');
      if (holders(previous, before) !== holders(next, after)) return true;
    }
  }
  return stageStructure(previous) !== stageStructure(next);
}

/** A label definition without its display parts; the sets in it sorted. 'null' for no label. */
function labelRule(label: LabelDefinition | undefined): string {
  if (!label) return 'null';
  const { name: _name, meaning: _meaning, color: _color, ...rule } = label;
  const setBy =
    typeof rule.setBy === 'object'
      ? {
          ...rule.setBy,
          ...(rule.setBy.duties ? { duties: [...rule.setBy.duties].sort() } : {}),
          ...(rule.setBy.members ? { members: [...rule.setBy.members].sort() } : {}),
        }
      : rule.setBy;
  const clearedWhen = rule.clearedWhen?.map(canonical).sort();
  return canonical({ ...rule, setBy, clearedWhen });
}

/**
 * The stages' order, ids, kinds and gate conditions. Every stage counts, with or without a gate: a
 * new ungated stage before a gated one, or a moved stage, skips the gate.
 */
function stageStructure(config: ProjectConfig): string {
  return canonical(
    config.pipeline.stages.map((stage) => ({
      id: stage.id,
      kind: stage.kind,
      conditions: (stage.gate?.conditions ?? [])
        .map((condition) => ({
          type: condition.type,
          label: condition.label,
          when: condition.when ?? null,
        }))
        .sort(
          (a, b) =>
            a.type.localeCompare(b.type) ||
            a.label.localeCompare(b.label) ||
            (a.when ?? '').localeCompare(b.when ?? ''),
        ),
    })),
  );
}

function ownerSettingsChanged(previous: ProjectConfig, next: ProjectConfig): boolean {
  if (ownerOnlyChanges(previous, next).length > 0) return true;
  const rounds = (config: ProjectConfig) => config.team.limits.maxFixRounds ?? DEFAULT_MAX_FIX_ROUNDS;
  return rounds(previous) !== rounds(next);
}

/** Members and the temporary workers (the system adds AI members for them). Leave is the one exception. */
function membersChanged(previous: ProjectConfig, next: ProjectConfig): boolean {
  const members = (config: ProjectConfig) =>
    canonical(
      [...config.team.members]
        .sort((a, b) => a.handle.localeCompare(b.handle))
        .map((member) => {
          if (member.kind !== 'ai') return member;
          const { onLeave: _onLeave, ...rest } = member;
          return rest;
        }),
    );
  if (members(previous) !== members(next)) return true;
  return canonical(previous.team.limits.tempWorkers) !== canonical(next.team.limits.tempWorkers);
}
