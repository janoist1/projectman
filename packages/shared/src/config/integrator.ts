import { z } from 'zod';
import type { LabelDefinition } from '../domain/label';
import { isOwnerApprovalLabel, labelHolders } from './labels';
import { ownerOnlyChanges } from './owner-only';
import { DEFAULT_MAX_FIX_ROUNDS } from './schema';
import type { ProjectConfig } from './schema';

/** What the integrator key may not change (PM-418), in the order integratorConfigRefusal checks them. */
export const IntegratorRefusal = z.enum(['approval_rules', 'owner_settings', 'members', 'invitations']);
export type IntegratorRefusal = z.infer<typeof IntegratorRefusal>;

/**
 * Why the integrator key may not commit `next` over `previous`, or null when it may. Compares the
 * end result, so PUT, PATCH, roles, members and revert are decided alike. Never 'invitations'.
 *
 * The key is the owner's actor for everything but approvals and owner-only rules: a rule that
 * weakened an approval, or made a human account, would let the key approve through the back door.
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

/** JSON with recursively sorted object keys and no `undefined` fields; array order stays. */
function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? 'null';
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, field]) => field !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, field]) => [key, sortKeys(field)]),
    );
  }
  return value;
}
