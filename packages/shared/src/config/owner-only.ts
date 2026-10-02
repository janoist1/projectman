import { isHumanOnlyLabel } from '../domain/label';
import { DEFAULT_NEW_MEMBER_APPROVER, DEFAULT_PERMISSION_MODE } from '../domain/member';
import { BUILT_IN_ROLE_IDS } from '../domain/role';
import { dutyMembers, roleBundle } from './duties';
import { stageApprovers } from './gates';
import { labelDefinition, labelHolders } from './labels';
import { approverOf } from './permission-level';
import type { AiMemberConfig, ProjectConfig } from './schema';

/**
 * Configuration changes only an owner may make (checked on every configuration commit by a
 * human who is not an owner):
 * - `locations`: the workspace or a repository path;
 * - `admin_or_account`: granting admin access, or changing a human's account (email) binding,
 *   except an invitation claiming a seat that had no account yet;
 * - `approval_policy`: approvals (gate labels only humans may set) and who may give them,
 *   release four eyes, boundary delegation settings, and who holds or grants authorization duties;
 * - `release_approvers`: who approves the release stages;
 * - `owners`: who is an owner;
 * - `permissions`: an AI member's permission mode or approver (who answers when the CLI asks), or
 *   a new AI member that starts with other than the defaults.
 */
export type OwnerOnlyChange =
  'locations' | 'admin_or_account' | 'approval_policy' | 'release_approvers' | 'owners' | 'permissions';

/** The owner-only changes from `previous` to `next`, in the order above; empty when there are none. */
export function ownerOnlyChanges(
  previous: ProjectConfig,
  next: ProjectConfig,
  opts: { invitationBinding?: { handle: string; email: string } } = {},
): OwnerOnlyChange[] {
  const changes: OwnerOnlyChange[] = [];
  if (locationsSignature(previous) !== locationsSignature(next)) changes.push('locations');
  if (adminOrAccountChanged(previous, next, opts.invitationBinding)) changes.push('admin_or_account');
  if (approvalPolicyChanged(previous, next)) changes.push('approval_policy');
  if (releaseApproversSignature(previous) !== releaseApproversSignature(next))
    changes.push('release_approvers');
  if (ownersSignature(previous) !== ownersSignature(next)) changes.push('owners');
  if (permissionsChanged(previous, next)) changes.push('permissions');
  return changes;
}

/**
 * An existing AI member's mode or approver differs, or a new AI member does not start with the
 * default mode and approver. An absent approver counts as `human`, so restating it changes nothing.
 */
function permissionsChanged(previous: ProjectConfig, next: ProjectConfig): boolean {
  const signature = (member: AiMemberConfig | undefined) =>
    member
      ? `${member.permissionMode}:${approverOf(member)}`
      : `${DEFAULT_PERMISSION_MODE}:${DEFAULT_NEW_MEMBER_APPROVER}`;
  return next.team.members.some((member) => {
    if (member.kind !== 'ai') return false;
    const old = previous.team.members.find((m) => m.handle === member.handle);
    return signature(member) !== signature(old?.kind === 'ai' ? old : undefined);
  });
}

/** Stage and condition ordering do not alter the approval policy. Removal does. */
export function approvalPolicyChanged(previous: ProjectConfig, next: ProjectConfig): boolean {
  const boundarySignature = (config: ProjectConfig) =>
    JSON.stringify({
      settings: config.team.boundary ?? { enabled: false, leadTimeoutSeconds: 120 },
      holders: dutyMembers(config, 'boundary_authorization')
        .map((m) => m.handle)
        .sort(),
      roles: [...BUILT_IN_ROLE_IDS, ...config.team.roles.map((r) => r.id)]
        .filter((r) => roleBundle(config, r).duties.includes('boundary_authorization'))
        .sort(),
    });
  if (boundarySignature(previous) !== boundarySignature(next)) return true;
  // Approvals are gate labels only humans may set; their holders are part of the policy.
  const signature = (config: ProjectConfig) =>
    JSON.stringify(
      config.pipeline.stages
        .map((stage) => ({
          id: stage.id,
          // `when` is part of the policy: narrowing an approval to some tasks is the owner's decision.
          approvals: (stage.gate?.conditions ?? [])
            .filter((condition) => condition.type === 'has_label')
            .flatMap((condition) => {
              const label = labelDefinition(config, condition.label);
              return label && isHumanOnlyLabel(label)
                ? [{ label: label.id, when: condition.when, holders: labelHolders(config, label).sort() }]
                : [];
            })
            .sort((a, b) => a.label.localeCompare(b.label) || (a.when ?? '').localeCompare(b.when ?? '')),
        }))
        .filter((stage) => stage.approvals.length)
        .sort((a, b) => a.id.localeCompare(b.id)),
    );
  const releaseSignature = (config: ProjectConfig) =>
    JSON.stringify({
      fourEyes: config.team.releaseFourEyes ?? false,
      holders: dutyMembers(config, 'release_approval')
        .map((m) => m.handle)
        .sort(),
      roles: [...BUILT_IN_ROLE_IDS, ...config.team.roles.map((r) => r.id)]
        .filter((r) => roleBundle(config, r).duties.includes('release_approval'))
        .sort(),
    });
  return signature(previous) !== signature(next) || releaseSignature(previous) !== releaseSignature(next);
}

/** @deprecated Renamed to `approvalPolicyChanged`; `ownerOnlyChanges` covers every owner-only rule. */
export const humanApprovalChanged = approvalPolicyChanged;

function locationsSignature(config: ProjectConfig): string {
  return JSON.stringify({
    workspace: config.project.workspacePath,
    repos: config.project.repos.map((repo) => ({ name: repo.name, path: repo.path })),
  });
}

function adminOrAccountChanged(
  previous: ProjectConfig,
  next: ProjectConfig,
  invitationBinding: { handle: string; email: string } | undefined,
): boolean {
  return next.team.members.some((member) => {
    if (member.kind !== 'human') return false;
    const old = previous.team.members.find((m) => m.handle === member.handle);
    const grantsAdmin = member.access === 'admin' && (old?.kind !== 'human' || old.access !== 'admin');
    const rebinds =
      old?.kind === 'human' &&
      (old.email ?? '').toLowerCase() !== (member.email ?? '').toLowerCase() &&
      !(
        invitationBinding?.handle === member.handle &&
        !old.email &&
        member.email === invitationBinding.email
      );
    return grantsAdmin || rebinds;
  });
}

/** Every release stage and its human approvers. */
function releaseApproversSignature(config: ProjectConfig): string {
  return config.pipeline.stages
    .filter((s) => s.kind === 'release')
    .map((s) => `${s.id}:${stageApprovers(config, s).sort().join(',')}`)
    .sort()
    .join('|');
}

/** Who holds owner access, with their account. */
function ownersSignature(config: ProjectConfig): string {
  return config.team.members
    .filter((m) => m.kind === 'human' && m.access === 'owner')
    .map((m) => `${m.handle}:${m.kind === 'human' ? m.email?.trim().toLowerCase() : ''}`)
    .sort()
    .join(',');
}
