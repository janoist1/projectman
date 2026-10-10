import { z } from 'zod';
import { MemberHandle } from '../domain/member';
import { canonical } from './canonical';
import { integratorConfigRefusal } from './integrator';
import { memberOf } from './lookup';
import { OPERATOR_ROLE, isOperator } from './operator-member';
import { ownerOnlyChanges } from './owner-only';
import type { OwnerOnlyChange } from './owner-only';
import { approverOf, outboundNetworkOf } from './permission-level';
import type { AiMemberConfig, MemberConfig, ProjectConfig } from './schema';

export {
  OPERATOR_ROLE,
  isOperator,
  isOperatorActor,
  isRequiredOperator,
  operatorOf,
} from './operator-member';

/**
 * What the Operator may do with a configuration change (PM-447):
 * - `now`: it makes the change on the owner's request, no further approval;
 * - `approval`: it prepares the change and the owner approves it first (closed by default);
 * - `never`: it does not make the change; the owner does it in the settings.
 */
export const OperatorLevel = z.enum(['now', 'approval', 'never']);
export type OperatorLevel = z.infer<typeof OperatorLevel>;

/** The part of the configuration a changed field belongs to. */
export const ConfigChangeArea = z.enum([
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
export type ConfigChangeArea = z.infer<typeof ConfigChangeArea>;

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
  level: OperatorLevel,
});
export type ConfigChangeRow = z.infer<typeof ConfigChangeRow>;

export interface OperatorConfigVerdict {
  level: OperatorLevel;
  changes: ConfigChangeRow[];
}

const LEVEL_RANK: Record<OperatorLevel, number> = { now: 0, approval: 1, never: 2 };

/** An AI member's fields the Operator changes without approval, on any member but itself. */
const NOW_MEMBER_FIELDS: readonly string[] = ['model', 'effort', 'capacity', 'onLeave', 'schedule'];

/**
 * The only fields of the Operator's member anybody may change (PM-473): the model with its provider,
 * and the effort. Its name, instructions, capacity and schedule are fixed, it cannot be retired, sent
 * on leave or joined by a second one.
 */
export const OPERATOR_SETTABLE_FIELDS = ['model', 'provider', 'effort'] as const;

/** What kind of change to the Operator `operatorFixedChange` found. */
export const OperatorFixedChange = z.object({
  kind: z.enum(['retire', 'second', 'leave', 'field']),
  handle: MemberHandle.nullable(),
  field: z.string().nullable(),
});
export type OperatorFixedChange = z.infer<typeof OperatorFixedChange>;

const SETTABLE: readonly string[] = OPERATOR_SETTABLE_FIELDS;

/**
 * What `next` changes on the Operator that nobody may change; null when nothing. The first finding, in
 * this order:
 * - `retire`: none of the Operators of `previous` is one in `next` (retired, or its role changed).
 *   Retiring one of two is allowed: an older configuration may hold two;
 * - `second`: more than one `ai_operator` AI member in `next`, one of them new (a temp worker counts),
 *   or the temp workers' role became `ai_operator`;
 * - `leave`: an Operator of `next` is on leave;
 * - `field`: an Operator on both sides differs in a field other than the settable ones (compared as
 *   `memberRows` does, so a restated default is no change), or the `ai_operator` role override changed.
 *   The sponsor may change when the old one is no longer a human member and the new one is.
 */
export function operatorFixedChange(
  previous: Pick<ProjectConfig, 'team'> | null,
  next: Pick<ProjectConfig, 'team'>,
): OperatorFixedChange | null {
  const wasOperators = previous?.team.members.filter((m) => isOperator(m)) ?? [];
  if (wasOperators.length > 0 && !wasOperators.some((m) => isOperator(memberOf(next, m.handle)))) {
    return { kind: 'retire', handle: wasOperators[0]!.handle, field: null };
  }

  const holdsRole = (m: MemberConfig) => m.kind === 'ai' && m.role === OPERATOR_ROLE;
  const roleHolders = next.team.members.filter(holdsRole);
  if (roleHolders.length > 1) {
    const added = roleHolders.find((m) => {
      const old = previous ? memberOf(previous, m.handle) : undefined;
      return !old || !holdsRole(old);
    });
    if (added) return { kind: 'second', handle: added.handle, field: null };
  }
  if (
    next.team.limits.tempWorkers.role === OPERATOR_ROLE &&
    previous?.team.limits.tempWorkers.role !== OPERATOR_ROLE
  ) {
    return { kind: 'second', handle: null, field: 'limits.tempWorkers.role' };
  }

  const operators = next.team.members.filter((m) => isOperator(m));
  const away = operators.find((m) => m.kind === 'ai' && m.onLeave === true);
  if (away) return { kind: 'leave', handle: away.handle, field: 'onLeave' };

  if (previous) {
    for (const member of operators) {
      const old = memberOf(previous, member.handle);
      if (!old || !isOperator(old)) continue;
      const field = fixedFieldChanged(old, member, next);
      if (field) return { kind: 'field', handle: member.handle, field };
    }
    if (
      canonical(previous.team.roleOverrides?.[OPERATOR_ROLE]) !==
      canonical(next.team.roleOverrides?.[OPERATOR_ROLE])
    ) {
      return { kind: 'field', handle: null, field: `roleOverrides.${OPERATOR_ROLE}` };
    }
  }
  return null;
}

/** The first (alphabetically) field of an Operator that differs, outside the settable ones; null when none. */
function fixedFieldChanged(
  before: MemberConfig,
  after: MemberConfig,
  next: Pick<ProjectConfig, 'team'>,
): string | null {
  const a = normalizedMember(before);
  const b = normalizedMember(after);
  const fields = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  for (const field of fields) {
    if (SETTABLE.includes(field) || canonical(a[field]) === canonical(b[field])) continue;
    if (field === 'sponsor' && sponsorHandedOver(a[field], b[field], next)) continue;
    return field;
  }
  return null;
}

/** The old sponsor is gone from the people of `next` and the new one is one of them: forced by a removal. */
function sponsorHandedOver(
  oldSponsor: unknown,
  newSponsor: unknown,
  next: Pick<ProjectConfig, 'team'>,
): boolean {
  return (
    typeof oldSponsor === 'string' &&
    typeof newSponsor === 'string' &&
    memberOf(next, oldSponsor)?.kind !== 'human' &&
    memberOf(next, newSponsor)?.kind === 'human'
  );
}

type Entity = Record<string, unknown>;
type InvitationBinding = NonNullable<
  NonNullable<Parameters<typeof ownerOnlyChanges>[2]>['invitationBinding']
>;

/**
 * What the Operator may do with the change from `previous` to `next`, by its end result (so a revert is
 * judged by what it would change). `level` is the highest of the rows (never > approval > now); no
 * change is `{ level: 'now', changes: [] }`.
 *
 * - never: any change to a person (a human member's field, adding or removing one), and what makes an
 *   owner or changes an admin or an account binding;
 * - never also: whatever makes the Operator other than fixed (`operatorFixedChange`): adding or
 *   removing an Operator, any field of its member but the settable ones, its role's override;
 * - now, only: an AI member's `model`, `effort`, `capacity`, `onLeave` and `schedule` (not the
 *   Operator's own member), a stage's `name`, a role's `instructions`;
 * - approval: everything else, so a field the rules do not name is closed by default. That covers
 *   what `integratorConfigRefusal` or `ownerOnlyChanges` names (apart from the model, effort,
 *   capacity and schedule of an AI member: the integrator may not touch members, but the owner asked
 *   for these to go straight through), the Operator's own model, provider and effort (it changes
 *   itself only with the owner's approval) and the instructions of its own role (it may not rewrite
 *   itself).
 */
export function operatorConfigVerdict(
  previous: ProjectConfig,
  next: ProjectConfig,
  opts: { operator: MemberHandle; invitationBinding?: InvitationBinding },
): OperatorConfigVerdict {
  const ownRoles = new Set<string>([OPERATOR_ROLE]);
  for (const config of [previous, next]) {
    const own = memberOf(config, opts.operator);
    if (own?.kind === 'ai') ownRoles.add(own.role);
  }
  const changes = [
    ...projectRows(previous, next),
    ...memberRows(previous, next, opts.operator),
    ...roleRows(previous, next, ownRoles),
    ...teamRows(previous, next),
    ...pipelineRows(previous, next),
  ];

  // Safety net: the rules below name what the comparison above should already have shown. Whatever
  // they name and it did not is at least a closed change, and an owner, an account or a change to
  // the fixed Operator is never.
  if (operatorFixedChange(previous, next) && highestLevel(changes) !== 'never') {
    changes.push(unnamed('member', 'operator_fixed', 'never'));
  }
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

function highestLevel(changes: readonly ConfigChangeRow[]): OperatorLevel {
  return changes.reduce<OperatorLevel>(
    (top, row) => (LEVEL_RANK[row.level] > LEVEL_RANK[top] ? row.level : top),
    'now',
  );
}

const OWNER_ONLY_AREA: Record<OwnerOnlyChange, ConfigChangeArea> = {
  locations: 'project',
  admin_or_account: 'member',
  approval_policy: 'gate',
  release_approvers: 'release',
  owners: 'member',
  permissions: 'member',
};

/** A row for a rule that names a change the field-by-field comparison did not show; a safety net, not a path. */
function unnamed(area: ConfigChangeArea, field: string, level: OperatorLevel): ConfigChangeRow {
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
  levelOf: (field: string) => OperatorLevel,
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
  level: OperatorLevel,
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
  levelOf: (item: T, field: string) => OperatorLevel,
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
    onLeave: member.onLeave ?? false,
    approver: approverOf(member),
    outboundNetwork: outboundNetworkOf(member),
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
  const presence = (member: MemberConfig): OperatorLevel =>
    member.kind === 'human' || isOperator(member) ? 'never' : 'approval';
  for (const [handle, member] of before)
    if (!after.has(handle))
      rows.push(presenceRow('member', handle, describe(member), null, presence(member)));
  for (const [handle, member] of after) {
    const old = before.get(handle);
    if (!old) {
      rows.push(presenceRow('member', handle, null, describe(member), presence(member)));
      continue;
    }
    const people = old.kind === 'human' || member.kind === 'human';
    const fixed = isOperator(old);
    const levelOfField = (field: string): OperatorLevel =>
      people || (fixed && !SETTABLE.includes(field))
        ? 'never'
        : !fixed && handle !== operator && NOW_MEMBER_FIELDS.includes(field)
          ? 'now'
          : 'approval';
    rows.push(...fieldRows('member', handle, normalizedMember(old), normalizedMember(member), levelOfField));
  }
  return rows;
}

/** Custom roles and the overrides of built-in ones. Instructions go through, except those of the Operator's own role. */
function roleRows(
  previous: ProjectConfig,
  next: ProjectConfig,
  ownRoles: ReadonlySet<string>,
): ConfigChangeRow[] {
  const instructionsLevel = (role: string, field: string): OperatorLevel =>
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
    ).map((row) => (row.target === OPERATOR_ROLE ? { ...row, level: 'never' as const } : row)),
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
    ...fieldRows('project', null, previous.team, next.team, () => 'approval', known),
  ];
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
