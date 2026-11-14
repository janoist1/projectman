import { z } from 'zod';
import {
  DEFAULT_AGENT_PROVIDER,
  DEFAULT_NEW_MEMBER_APPROVER,
  DEFAULT_OUTBOUND_NETWORK,
  DEFAULT_PERMISSION_MODE,
  MemberHandle,
} from '../domain/member';
import { canonical } from './canonical';
import { integratorConfigRefusal } from './integrator';
import { memberOf } from './lookup';
import { ownerOnlyChanges } from './owner-only';
import type { OwnerOnlyChange } from './owner-only';
import { ownerReservedEffect } from './super-mutation';
import { machineAccessOf } from './machine-access';
import { approverOf, outboundNetworkOf } from './permission-level';
import type { AiMemberConfig, MemberConfig, ProjectConfig } from './schema';
import { effectiveTeamSettings } from './team-settings';

export {
  RETIRED_OPERATOR_HANDLE,
  coordinatorSuperActorOf,
  isConnectedOwnerActor,
  isCoordinatorSuperActor,
  isOwnerReleaseActor,
} from './operator-member';

/**
 * What the project manager may do with a configuration change (PM-447):
 * - `now`: it makes the change on the owner's request, no further approval;
 * - `approval`: it prepares the change and the owner approves it first (closed by default);
 * - `never`: it does not make the change; the owner does it in the settings.
 */
export const ProjectManagerLevel = z.enum(['now', 'approval', 'never']);
export type ProjectManagerLevel = z.infer<typeof ProjectManagerLevel>;

/** The part of the configuration a changed field belongs to. */
const ConfigChangeArea = z.enum([
  'project',
  'member',
  'role',
  'stage',
  'label',
  'gate',
  'limits',
  'repos',
  'boundary',
  'release',
]);
type ConfigChangeArea = z.infer<typeof ConfigChangeArea>;

/**
 * One changed field. `target` names what changed inside the area: a member's handle, a role, stage,
 * label, repository or column id; null when the area itself. `field` is the configuration field's name
 * (`model`, `onLeave`, `outboundNetwork`, `name`, `setBy`, ...), or `*` when the target itself was
 * added or removed: then the value is a short descriptor of it (the role, the name or the path), not its
 * whole definition. Values are text; what is not text stands as JSON with sorted keys; no value is null.
 */
export const ConfigChangeRow = z.object({
  area: ConfigChangeArea,
  target: z.string().nullable(),
  field: z.string(),
  before: z.string().nullable(),
  after: z.string().nullable(),
  level: ProjectManagerLevel,
});
export type ConfigChangeRow = z.infer<typeof ConfigChangeRow>;

export interface ProjectManagerConfigVerdict {
  level: ProjectManagerLevel;
  changes: ConfigChangeRow[];
}

const LEVEL_RANK: Record<ProjectManagerLevel, number> = { now: 0, approval: 1, never: 2 };

/** An AI member's fields the project manager changes without approval, on any member but itself. */
const NOW_MEMBER_FIELDS: readonly string[] = ['model', 'effort', 'capacity', 'onLeave', 'schedule'];

type Entity = Record<string, unknown>;
type InvitationBinding = NonNullable<
  NonNullable<Parameters<typeof ownerOnlyChanges>[2]>['invitationBinding']
>;

/**
 * What the project manager may do with the change from `previous` to `next`, by its end result (so a revert is
 * judged by what it would change). `level` is the highest of the rows (never > approval > now); no
 * change is `{ level: 'now', changes: [] }`.
 *
 * - never: any change to a person (a human member's field, adding or removing one), and what makes an
 *   owner or changes an admin or an account binding;
 * - now, only: an AI member's `model`, `effort`, `capacity`, `onLeave` and `schedule` (not the
 *   acting member's own), a stage's `name`, a role's `instructions`;
 * - approval: everything else, so a field the rules do not name is closed by default. That covers
 *   what `integratorConfigRefusal` or `ownerOnlyChanges` names (apart from the model, effort,
 *   capacity and schedule of an AI member: the integrator may not touch members, but the owner asked
 *   for these to go straight through), the acting member's own fields (it changes itself only with
 *   the owner's approval) and the instructions of its own role (it may not rewrite itself).
 */
export function superConfigVerdict(
  previous: ProjectConfig,
  next: ProjectConfig,
  opts: { operator: MemberHandle; invitationBinding?: InvitationBinding },
): ProjectManagerConfigVerdict {
  const ownRoles = new Set<string>();
  for (const config of [previous, next]) {
    const own = memberOf(config, opts.operator);
    if (own?.kind === 'ai') ownRoles.add(own.role);
  }
  const changes = [
    ...fieldRows('project', null, previous, next, () => 'approval', [
      'schemaVersion',
      'project',
      'team',
      'pipeline',
    ]),
    ...projectRows(previous, next),
    ...memberRows(previous, next, opts.operator),
    ...roleRows(previous, next, ownRoles),
    ...teamRows(previous, next),
    ...pipelineRows(previous, next),
  ];

  // Safety net: the rules below name what the comparison above should already have shown. Whatever
  // they name and it did not is at least a closed change, and an owner or an account is never.
  const owner = ownerOnlyChanges(previous, next, { invitationBinding: opts.invitationBinding });
  const rank = () => LEVEL_RANK[highestLevel(changes)];
  for (const change of owner.filter((c) => c === 'owners' || c === 'admin_or_account')) {
    if (rank() < LEVEL_RANK.never) changes.push(unnamed('member', change, 'never'));
  }
  for (const change of owner) {
    if (rank() < LEVEL_RANK.approval) changes.push(unnamed(OWNER_ONLY_AREA[change], change, 'approval'));
  }
  if (rank() < LEVEL_RANK.approval) {
    const refusal = integratorConfigRefusal(
      withNormalizedMembers(previous),
      withNormalizedMembers(withoutNowMemberFields(previous, next, opts.operator)),
    );
    if (refusal !== null) changes.push(unnamed('member', refusal, 'approval'));
  }

  return { level: highestLevel(changes), changes };
}

/**
 * What the project manager may do with a change the owner asked for in the app (decision 55): the owner's request
 * is the approval, so a change the verdict holds for approval goes straight through, except what stays the
 * owner's own call. `approval` becomes `now` unless
 * - a row is about the project manager's own member or its own role (it does not rewrite itself), or
 * - the change has an owner-reserved effect (deletion, security, cost: `ownerReservedEffect`).
 * `never` stays `never`, and a `now` stays `now`.
 */
export function superAutonomousLevel(
  previous: ProjectConfig,
  next: ProjectConfig,
  verdict: ProjectManagerConfigVerdict,
  operator: MemberHandle,
): ProjectManagerLevel {
  if (verdict.level !== 'approval') return verdict.level;
  const ownRoles = new Set<string>();
  for (const config of [previous, next]) {
    const own = memberOf(config, operator);
    if (own?.kind === 'ai') ownRoles.add(own.role);
  }
  const aboutItself = verdict.changes.some(
    (row) =>
      (row.area === 'member' && row.target === operator) ||
      (row.area === 'role' && row.target !== null && ownRoles.has(row.target)),
  );
  if (aboutItself) return 'approval';
  return ownerReservedEffect(previous, { kind: 'config_change', next }) === null ? 'now' : 'approval';
}

function highestLevel(changes: readonly ConfigChangeRow[]): ProjectManagerLevel {
  return changes.reduce<ProjectManagerLevel>(
    (top, row) => (LEVEL_RANK[row.level] > LEVEL_RANK[top] ? row.level : top),
    'now',
  );
}

const OWNER_ONLY_AREA: Record<OwnerOnlyChange, ConfigChangeArea> = {
  email_send_policy: 'member',
  machine_access: 'member',
  task_create_access: 'member',
  owner_decision_topics: 'project',
  project_manager_authority: 'project',
  start_condition: 'project',
  locations: 'project',
  admin_or_account: 'member',
  approval_policy: 'gate',
  release_approvers: 'release',
  owners: 'member',
  permissions: 'member',
  review_test: 'repos',
  compute_jobs: 'repos',
  operator_watch: 'project',
};

/** A row for a rule that names a change the field-by-field comparison did not show; a safety net, not a path. */
function unnamed(area: ConfigChangeArea, field: string, level: ProjectManagerLevel): ConfigChangeRow {
  return { area, target: null, field, before: null, after: null, level };
}

/** `next` with the AI members' fields that go straight through set back to `previous`, for the integrator check. */
function withoutNowMemberFields(
  previous: ProjectConfig,
  next: ProjectConfig,
  operator: MemberHandle,
): ProjectConfig {
  return {
    ...next,
    team: {
      ...next.team,
      members: next.team.members.map((member) => {
        const old = previous.team.members.find((m) => m.handle === member.handle);
        if (member.kind !== 'ai' || old?.kind !== 'ai' || member.handle === operator) return member;
        const reverted: Entity = { ...member };
        for (const field of NOW_MEMBER_FIELDS) {
          const value = (old as Entity)[field];
          if (value === undefined) delete reverted[field];
          else reverted[field] = value;
        }
        return reverted as AiMemberConfig;
      }),
    },
  };
}

function valueText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return canonical(value);
}

/** One row per field whose value differs, in field-name order; `skip` names fields handled elsewhere. */
function fieldRows(
  area: ConfigChangeArea,
  target: string | null,
  before: Entity | undefined,
  after: Entity | undefined,
  levelOf: (field: string) => ProjectManagerLevel,
  skip: readonly string[] = [],
): ConfigChangeRow[] {
  const fields = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return [...fields]
    .filter((field) => !skip.includes(field))
    .filter((field) => canonical(before?.[field]) !== canonical(after?.[field]))
    .sort()
    .map((field) => ({
      area,
      target,
      field,
      before: valueText(before?.[field]),
      after: valueText(after?.[field]),
      level: levelOf(field),
    }));
}

/** An entity that exists on one side only: one `*` row. */
function presenceRow(
  area: ConfigChangeArea,
  target: string,
  before: string | null,
  after: string | null,
  level: ProjectManagerLevel,
  prefix = '',
): ConfigChangeRow {
  return { area, target, field: `${prefix}*`, before, after, level };
}

/**
 * Rows for a list of entities with an id, compared by id: added and removed ones as `*` rows, the
 * ones on both sides field by field, and a changed order of the ones on both sides as one `order` row.
 * Everything is closed by default (`approval`); `levelOf` opens a field. `fieldPrefix` marks a list that
 * shares its area with another ("column.name"); `levelOf` still gets the field's own name.
 */
function listRows<T extends object>(
  area: ConfigChangeArea,
  previous: readonly T[],
  next: readonly T[],
  idOf: (item: T) => string,
  describe: (item: T) => string,
  levelOf: (item: T, field: string) => ProjectManagerLevel,
  opts: { skip?: readonly string[]; fieldPrefix?: string } = {},
): ConfigChangeRow[] {
  const prefix = opts.fieldPrefix ?? '';
  const before = new Map(previous.map((item) => [idOf(item), item]));
  const after = new Map(next.map((item) => [idOf(item), item]));
  const rows: ConfigChangeRow[] = [];
  for (const [id, item] of before)
    if (!after.has(id)) rows.push(presenceRow(area, id, describe(item), null, 'approval', prefix));
  for (const [id, item] of after) {
    const old = before.get(id);
    if (!old) rows.push(presenceRow(area, id, null, describe(item), 'approval', prefix));
    else
      rows.push(
        ...fieldRows(area, id, old as Entity, item as Entity, (field) => levelOf(item, field), opts.skip).map(
          (row) => ({ ...row, field: prefix + row.field }),
        ),
      );
  }
  const common = (ids: Iterable<string>, other: Map<string, T>) => [...ids].filter((id) => other.has(id));
  const orderBefore = common(before.keys(), after).join(',');
  const orderAfter = common(after.keys(), before).join(',');
  if (orderBefore !== orderAfter)
    rows.push({
      area,
      target: null,
      field: `${prefix}order`,
      before: orderBefore,
      after: orderAfter,
      level: 'approval',
    });
  return rows;
}

/** The project's own data (name, workspace, language, time zone, key, template) and its repositories. */
function projectRows(previous: ProjectConfig, next: ProjectConfig): ConfigChangeRow[] {
  return [
    ...(previous.schemaVersion !== next.schemaVersion
      ? [
          {
            area: 'project' as const,
            target: null,
            field: 'schemaVersion',
            before: valueText(previous.schemaVersion),
            after: valueText(next.schemaVersion),
            level: 'approval' as const,
          },
        ]
      : []),
    ...fieldRows('project', null, previous.project, next.project, () => 'approval', ['repos']),
    ...listRows(
      'repos',
      previous.project.repos,
      next.project.repos,
      (repo) => repo.name,
      (repo) => repo.path,
      () => 'approval',
    ),
  ];
}

/** An AI member as compared: absent values stand as their defaults, so restating a default is no change. */
function normalizedMember(member: MemberConfig): Entity {
  if (member.kind !== 'ai') return { ...member };
  return {
    ...member,
    permissionMode: member.permissionMode ?? 'default',
    provider: member.provider ?? DEFAULT_AGENT_PROVIDER,
    onLeave: member.onLeave ?? false,
    approver: approverOf(member),
    outboundNetwork: outboundNetworkOf(member),
    machineAccess: machineAccessOf(member),
  };
}

/** The configuration with its members as compared, so a restated default does not look like a change to the integrator rule. */
function withNormalizedMembers(config: ProjectConfig): ProjectConfig {
  return {
    ...config,
    team: { ...config.team, members: config.team.members.map((m) => normalizedMember(m) as MemberConfig) },
  };
}

function memberRows(previous: ProjectConfig, next: ProjectConfig, operator: MemberHandle): ConfigChangeRow[] {
  const rows: ConfigChangeRow[] = [];
  const before = new Map(previous.team.members.map((m) => [m.handle, m]));
  const after = new Map(next.team.members.map((m) => [m.handle, m]));
  const describe = (member: MemberConfig) => (member.kind === 'ai' ? member.role : member.access);
  const presence = (member: MemberConfig): ProjectManagerLevel =>
    member.kind === 'human' ? 'never' : 'approval';
  for (const [handle, member] of before)
    if (!after.has(handle))
      rows.push(presenceRow('member', handle, describe(member), null, presence(member)));
  for (const [handle, member] of after) {
    const old = before.get(handle);
    if (!old) {
      rows.push(presenceRow('member', handle, null, describe(member), presence(member)));
      if (member.kind === 'ai') rows.push(...newMemberPermissionRows(member));
      continue;
    }
    const people = old.kind === 'human' || member.kind === 'human';
    const levelOfField = (field: string): ProjectManagerLevel =>
      people ? 'never' : handle !== operator && NOW_MEMBER_FIELDS.includes(field) ? 'now' : 'approval';
    rows.push(...fieldRows('member', handle, normalizedMember(old), normalizedMember(member), levelOfField));
  }
  // Duty-derived stage owners preserve roster order, so a reorder can change the selected merger.
  const orderBefore = [...before.keys()].filter((handle) => after.has(handle)).join(',');
  const orderAfter = [...after.keys()].filter((handle) => before.has(handle)).join(',');
  if (orderBefore !== orderAfter)
    rows.push({
      area: 'member',
      target: null,
      field: 'order',
      before: orderBefore,
      after: orderAfter,
      level: 'approval',
    });
  return rows;
}

/** Custom roles and the overrides of built-in ones. Instructions go through, except those of the acting member's own role. */
function roleRows(
  previous: ProjectConfig,
  next: ProjectConfig,
  ownRoles: ReadonlySet<string>,
): ConfigChangeRow[] {
  const instructionsLevel = (role: string, field: string): ProjectManagerLevel =>
    field === 'instructions' && !ownRoles.has(role) ? 'now' : 'approval';
  const overrides = (config: ProjectConfig) =>
    Object.entries(config.team.roleOverrides ?? {}).map(([id, bundle]) => ({ id, ...bundle }));
  return [
    ...listRows(
      'role',
      previous.team.roles,
      next.team.roles,
      (role) => role.id,
      (role) => role.name,
      (role, field) => instructionsLevel(role.id, field),
    ),
    ...listRows(
      'role',
      overrides(previous),
      overrides(next),
      (override) => override.id,
      (override) => override.id,
      (override, field) => instructionsLevel(override.id, field),
      { fieldPrefix: 'override.' },
    ),
  ];
}

/** Limits, delegation and release settings: all closed by default. */
function teamRows(previous: ProjectConfig, next: ProjectConfig): ConfigChangeRow[] {
  const known = ['members', 'roles', 'roleOverrides', 'releaseFourEyes', 'boundary', 'limits'];
  return [
    ...fieldRows('limits', null, previous.team.limits, next.team.limits, () => 'approval'),
    ...fieldRows('boundary', null, previous.team.boundary, next.team.boundary, () => 'approval'),
    ...fieldRows(
      'release',
      null,
      { releaseFourEyes: previous.team.releaseFourEyes },
      { releaseFourEyes: next.team.releaseFourEyes },
      () => 'approval',
    ),
    ...fieldRows(
      'project',
      null,
      effectiveTeamSettings(previous),
      effectiveTeamSettings(next),
      () => 'approval',
      known,
    ),
  ];
}

/** A new member's legal fields must be visible beside its short presence descriptor. */
function newMemberPermissionRows(member: AiMemberConfig): ConfigChangeRow[] {
  return fieldRows(
    'member',
    member.handle,
    {
      permissionMode: DEFAULT_PERMISSION_MODE,
      approver: DEFAULT_NEW_MEMBER_APPROVER,
      outboundNetwork: DEFAULT_OUTBOUND_NETWORK,
      machineAccess: false,
    },
    {
      permissionMode: member.permissionMode ?? 'default',
      approver: approverOf(member),
      outboundNetwork: outboundNetworkOf(member),
      machineAccess: machineAccessOf(member),
    },
    () => 'approval',
  );
}

/** Stages (only the name goes through), gates, board columns and labels. */
function pipelineRows(previous: ProjectConfig, next: ProjectConfig): ConfigChangeRow[] {
  const stageRows = listRows(
    'stage',
    previous.pipeline.stages,
    next.pipeline.stages,
    (stage) => stage.id,
    (stage) => stage.name,
    (_stage, field) => (field === 'name' ? 'now' : 'approval'),
    { skip: ['gate'] },
  );
  const gateRows = next.pipeline.stages.flatMap((stage) => {
    const old = previous.pipeline.stages.find((s) => s.id === stage.id);
    return old ? fieldRows('gate', stage.id, { gate: old.gate }, { gate: stage.gate }, () => 'approval') : [];
  });
  return [
    ...stageRows,
    ...gateRows,
    ...listRows(
      'stage',
      previous.pipeline.columns,
      next.pipeline.columns,
      (column) => column.id,
      (column) => column.name,
      () => 'approval',
      { fieldPrefix: 'column.' },
    ),
    ...listRows(
      'label',
      previous.pipeline.labels,
      next.pipeline.labels,
      (label) => label.id,
      (label) => label.name,
      () => 'approval',
    ),
    ...fieldRows('project', null, previous.pipeline, next.pipeline, () => 'approval', [
      'columns',
      'stages',
      'labels',
    ]),
  ];
}
