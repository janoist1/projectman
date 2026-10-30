import { isHumanOnlyLabel } from '../domain/label';
import {
  DEFAULT_NEW_MEMBER_APPROVER,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_OUTBOUND_NETWORK,
} from '../domain/member';
import { BUILT_IN_ROLE_IDS } from '../domain/role';
import { canonical } from './canonical';
import { dutyMembers, roleBundle } from './duties';
import { stageApprovers } from './gates';
import { labelDefinition, labelHolders } from './labels';
import { machineAccessOf } from './machine-access';
import { approverOf, outboundNetworkOf } from './permission-level';
import type { AiMemberConfig, ProjectConfig } from './schema';
import { TEAM_SETTING_KEYS, TEAM_SETTING_POLICY, teamSettingValue } from './team-settings';

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
 *   a new AI member that starts with other than the defaults;
 * - `review_test`: a repository's full test, `reviewTest` (the shell command the server runs in the
 *   full test sandbox) or `fullTestAtMerge` (when it runs) (PM-538);
 * - `compute_jobs`: a repository's compute jobs, `computeJobs`: their commands run on GitHub with the right to
 *   attest their outputs (PM-1148);
 * - `operator_watch`: how much the Operator does on its own on a system signal (PM-548);
 * - `operator_approval_waiver`: whether eligible Operator changes may skip the approval click (PM-691);
 * - `email_send_policy`: whether an AI member can send email without human approval (PM-940), except
 *   that switching sending on or off clears the bypass with it (PM-956);
 * - `machine_access`: whether an AI member may put machine work in the owners' queue (decision 66), by its
 *   effective value (`machineAccessOf`);
 * - `task_create_access`: the lowest human access that may open a new card (PM-1100), by its effective value
 *   (`taskCreateAccessOf`).
 */
const OWNER_ONLY_CHANGES = [
  'locations',
  'admin_or_account',
  'approval_policy',
  'release_approvers',
  'owners',
  'permissions',
  'review_test',
  'compute_jobs',
  'operator_watch',
  'operator_approval_waiver',
  'email_send_policy',
  'machine_access',
  'task_create_access',
] as const;
export type OwnerOnlyChange = (typeof OWNER_ONLY_CHANGES)[number];

/**
 * The owner-only changes from `previous` to `next`, in the order above; empty when there are none. A team
 * setting counts by its effective value under the change `TEAM_SETTING_POLICY` names for it; the checks
 * below cover what is not one setting.
 */
export function ownerOnlyChanges(
  previous: ProjectConfig,
  next: ProjectConfig,
  opts: { invitationBinding?: { handle: string; email: string } } = {},
): OwnerOnlyChange[] {
  const checks: Partial<Record<OwnerOnlyChange, () => boolean>> = {
    locations: () => locationsSignature(previous) !== locationsSignature(next),
    admin_or_account: () => adminOrAccountChanged(previous, next, opts.invitationBinding),
    approval_policy: () => approvalPolicyChanged(previous, next),
    release_approvers: () => releaseApproversSignature(previous) !== releaseApproversSignature(next),
    owners: () => ownersSignature(previous) !== ownersSignature(next),
    permissions: () => permissionsChanged(previous, next),
    review_test: () => reviewTestSignature(previous) !== reviewTestSignature(next),
    compute_jobs: () => computeJobsSignature(previous) !== computeJobsSignature(next),
    email_send_policy: () => emailSendPolicyChanged(previous, next),
    machine_access: () => machineAccessChanged(previous, next),
  };
  return OWNER_ONLY_CHANGES.filter(
    (change) =>
      TEAM_SETTING_KEYS.some(
        (key) =>
          TEAM_SETTING_POLICY[key].ownerOnly === change &&
          canonical(teamSettingValue(previous, key)) !== canonical(teamSettingValue(next, key)),
      ) || checks[change]?.() === true,
  );
}

/** An AI member's bypass of the email approval differs; switching sending on or off clears it with it (PM-956). */
function emailSendPolicyChanged(previous: ProjectConfig, next: ProjectConfig): boolean {
  const policy = (member: ProjectConfig['team']['members'][number] | undefined) =>
    member?.kind === 'ai' && member.email?.sendWithoutApproval === true;
  const sending = (member: ProjectConfig['team']['members'][number] | undefined) =>
    member?.kind === 'ai' && member.email?.enabled === true;
  return next.team.members.some((member) => {
    if (member.kind !== 'ai') return false;
    const old = previous.team.members.find((m) => m.handle === member.handle);
    if (policy(member) === policy(old)) return false;
    return !(policy(old) && sending(old) !== sending(member));
  });
}

/**
 * An AI member's effective machine access differs; a new member counts as having none before. Compared by
 * the effective value, so restating the role's default changes nothing.
 */
function machineAccessChanged(previous: ProjectConfig, next: ProjectConfig): boolean {
  return next.team.members.some((member) => {
    if (member.kind !== 'ai') return false;
    const old = previous.team.members.find((m) => m.handle === member.handle);
    return machineAccessOf(member) !== (old !== undefined && machineAccessOf(old));
  });
}

/** The repositories that have compute jobs, with those jobs. */
function computeJobsSignature(config: ProjectConfig): string {
  return canonical(
    config.project.repos
      .filter((repo) => (repo.computeJobs?.length ?? 0) > 0)
      .map((repo) => ({ name: repo.name, computeJobs: repo.computeJobs ?? [] }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
}

/** The repositories that have a full test or run it only at the merge, with those two settings. */
function reviewTestSignature(config: ProjectConfig): string {
  return canonical(
    config.project.repos
      .filter((repo) => repo.reviewTest !== undefined || repo.fullTestAtMerge === true)
      .map((repo) => ({
        name: repo.name,
        reviewTest: repo.reviewTest ?? null,
        fullTestAtMerge: repo.fullTestAtMerge === true,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
}

/**
 * An existing AI member's mode, approver, or outbound network setting differs, or a new AI member does not start with the
 * default mode, approver, and outbound network setting. An absent approver counts as `human`, so restating it changes nothing.
 */
function permissionsChanged(previous: ProjectConfig, next: ProjectConfig): boolean {
  const signature = (member: AiMemberConfig | undefined) =>
    member
      ? `${member.permissionMode}:${approverOf(member)}:${outboundNetworkOf(member)}`
      : `${DEFAULT_PERMISSION_MODE}:${DEFAULT_NEW_MEMBER_APPROVER}:${DEFAULT_OUTBOUND_NETWORK}`;
  return next.team.members.some((member) => {
    if (member.kind !== 'ai') return false;
    const old = previous.team.members.find((m) => m.handle === member.handle);
    return signature(member) !== signature(old?.kind === 'ai' ? old : undefined);
  });
}

/** The boundary delegation: its settings and who, by member or by role, holds `boundary_authorization`. */
export function boundaryDelegationChanged(previous: ProjectConfig, next: ProjectConfig): boolean {
  const signature = (config: ProjectConfig) =>
    JSON.stringify({
      settings: teamSettingValue(config, 'boundary'),
      holders: dutyMembers(config, 'boundary_authorization')
        .map((m) => m.handle)
        .sort(),
      roles: [...BUILT_IN_ROLE_IDS, ...config.team.roles.map((r) => r.id)]
        .filter((r) => roleBundle(config, r).duties.includes('boundary_authorization'))
        .sort(),
    });
  return signature(previous) !== signature(next);
}

/**
 * Stage and condition ordering do not alter the approval policy. Removal does. The release four eyes and the
 * boundary settings count through `TEAM_SETTING_POLICY`.
 */
function approvalPolicyChanged(previous: ProjectConfig, next: ProjectConfig): boolean {
  if (boundaryDelegationChanged(previous, next)) return true;
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
      holders: dutyMembers(config, 'release_approval')
        .map((m) => m.handle)
        .sort(),
      roles: [...BUILT_IN_ROLE_IDS, ...config.team.roles.map((r) => r.id)]
        .filter((r) => roleBundle(config, r).duties.includes('release_approval'))
        .sort(),
    });
  return signature(previous) !== signature(next) || releaseSignature(previous) !== releaseSignature(next);
}

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
