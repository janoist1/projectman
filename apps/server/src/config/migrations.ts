import type { FastifyBaseLogger } from 'fastify';
import {
  AgentProvider,
  BUILT_IN_ROLE_DUTIES,
  BuiltInRoleId,
  DEFAULT_AGENT_PROVIDER,
  DEFAULT_PROJECT_LANGUAGE,
  DEFAULT_PRIORITY_SETTERS,
  DEFAULT_PROJECT_MANAGER_MOVES,
  DEFAULT_TEMP_MAX_POINTS,
  DEFAULT_VIEWER_RECIPIENTS,
  defaultMerger,
  FALLBACK_PERMISSION_MODE,
  isProjectManager,
  LabelDefinition,
  MAX_COMPLEXITY,
  type MemberConfig,
  PermissionMode,
  permissionModeFitsProvider,
  ProjectConfig,
  releaseApprovalSetBy,
  releaseApprovers,
  releaseGateAccepts,
  RETIRED_OPERATOR_ROLE,
} from '@projectman/shared';
import { DAILY_WORKER_SCHEDULE, migrateLegacyConfig, projectManagerMember } from '@projectman/templates';

interface MigrationContext {
  projectKey: string;
  logger: Pick<FastifyBaseLogger, 'warn'>;
}

/** The AI member objects of a raw configuration. */
function rawAiMembers(raw: unknown): Array<Record<string, unknown>> {
  if (!raw || typeof raw !== 'object' || !('team' in raw)) return [];
  const team = raw.team;
  if (!team || typeof team !== 'object' || !('members' in team) || !Array.isArray(team.members)) return [];
  return team.members.filter(
    (member): member is Record<string, unknown> =>
      Boolean(member) && typeof member === 'object' && member.kind === 'ai',
  );
}

/** The removed `scheduled` AI role: such members become maintainers with the daily worker schedule. */
function migrateScheduledRole(raw: unknown, { projectKey, logger }: MigrationContext): unknown {
  for (const member of rawAiMembers(raw)) {
    if (member.role !== 'scheduled') continue;
    member.role = 'maintainer';
    if (member.schedule === undefined) member.schedule = { ...DAILY_WORKER_SCHEDULE };
    logger.warn({ projectKey, member: member.handle }, 'Migrated legacy scheduled role to maintainer');
  }
  return raw;
}

/**
 * A Codex member in `bypassPermissions` (decision 19 forbids it): such a member reads as
 * `acceptEdits`, so the configuration still loads. A mode that is not a permission mode at all is
 * left for the schema to refuse.
 */
function migrateCodexBypass(raw: unknown, { projectKey, logger }: MigrationContext): unknown {
  for (const member of rawAiMembers(raw)) {
    const provider = AgentProvider.safeParse(member.provider ?? DEFAULT_AGENT_PROVIDER);
    const mode = PermissionMode.safeParse(member.permissionMode);
    if (!provider.success || !mode.success || permissionModeFitsProvider(provider.data, mode.data)) continue;
    member.permissionMode = FALLBACK_PERMISSION_MODE;
    logger.warn(
      { projectKey, member: member.handle },
      `Migrated ${provider.data} member from ${mode.data} to ${FALLBACK_PERMISSION_MODE}`,
    );
  }
  return raw;
}

/**
 * The removed Senior mark (PM-347, PM-1001): a permanent AI member marked `senior` gets the complexity
 * limit 13 unless it has one already, a temp worker none (its limit is always 5). The `senior` field is
 * dropped from every member, so the migration runs once.
 */
function migrateSeniorLimit(raw: unknown, { projectKey, logger }: MigrationContext): unknown {
  for (const member of rawAiMembers(raw)) {
    if (!('senior' in member)) continue;
    if (member.senior === true && !member.temp && member.complexityLimit === undefined)
      member.complexityLimit = MAX_COMPLEXITY;
    delete member.senior;
    logger.warn({ projectKey, member: member.handle }, 'Migrated the Senior mark to a complexity limit');
  }
  return raw;
}

/**
 * The removed separate mailbox name (PM-1039): an AI member's address is `<handle>@<domain>`. A name
 * that differed from the handle is gone with its address (the owner's decision); the log names the member.
 */
function dropEmailMailbox(raw: unknown, { projectKey, logger }: MigrationContext): unknown {
  for (const member of rawAiMembers(raw)) {
    const email = member.email;
    if (!email || typeof email !== 'object' || !('mailbox' in email)) continue;
    const mailbox = email.mailbox;
    delete (email as Record<string, unknown>).mailbox;
    if (mailbox !== member.handle)
      logger.warn(
        { projectKey, member: member.handle, mailbox },
        'Dropped the removed mailbox name; the address is the handle',
      );
  }
  return raw;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** For each label that gates require (has_label): the release stages and the other stages that do. */
function gateRequirements(stages: unknown[]): Map<string, { release: string[]; other: string[] }> {
  const required = new Map<string, { release: string[]; other: string[] }>();
  for (const entry of stages) {
    const stage = asRecord(entry);
    const conditions = asRecord(stage?.gate)?.conditions;
    if (!stage || !Array.isArray(conditions)) continue;
    for (const condition of conditions.map(asRecord)) {
      if (condition?.type !== 'has_label' || typeof condition.label !== 'string') continue;
      const gates = required.get(condition.label) ?? { release: [], other: [] };
      gates[stage.kind === 'release' ? 'release' : 'other'].push(String(stage.id));
      required.set(condition.label, gates);
    }
  }
  return required;
}

/**
 * A release approval that more than the holders of the release approval duty may give (decision
 * 19: a label any human may set let clients and viewers approve a release): the label a release
 * gate requires is narrowed to that duty, humans only. It is fail-closed: whoever approved by
 * another right loses it unless they hold the duty. A label that another stage's gate requires too
 * is narrowed for both. Nobody holding the duty would leave the release without an approver and
 * the project without a load, so such a label stays as it is, with a warning: the project loads
 * with the rule still broken (`isToleratedOnLoad`) until the owner grants the duty in settings.
 * Runs after the conversion of legacy gates, which defines labels of this kind too.
 */
function migrateReleaseApproval(raw: unknown, { projectKey, logger }: MigrationContext): unknown {
  const pipeline = asRecord(asRecord(raw)?.pipeline);
  if (!Array.isArray(pipeline?.stages) || !Array.isArray(pipeline.labels)) return raw;
  const required = gateRequirements(pipeline.stages);
  const tooWide = pipeline.labels.map(asRecord).filter((label): label is Record<string, unknown> => {
    const setBy = LabelDefinition.shape.setBy.safeParse(label?.setBy);
    return (
      typeof label?.id === 'string' &&
      (required.get(label.id)?.release.length ?? 0) > 0 &&
      setBy.success &&
      !releaseGateAccepts({ setBy: setBy.data })
    );
  });
  if (tooWide.length === 0) return raw;
  // Who holds the duty is only known from the whole configuration; an unreadable one fails its load anyway.
  const config = ProjectConfig.safeParse(raw);
  if (!config.success) return raw;
  const approvable = releaseApprovers(config.data).length > 0;
  for (const label of tooWide) {
    const gates = required.get(String(label.id));
    const details = {
      projectKey,
      label: label.id,
      releaseStages: gates?.release,
      otherStages: gates?.other,
      setBy: label.setBy,
    };
    if (approvable) {
      label.setBy = releaseApprovalSetBy();
      logger.warn(details, 'Narrowed release approval label to the release approval duty');
    } else {
      logger.warn(
        details,
        'Release approval label is not limited to the release approval duty, and nobody holds the duty; grant it in settings',
      );
    }
  }
  return raw;
}

/** The texts of a role that carry over to the override; an empty text would only hide the default. */
const ROLE_TEXT_FIELDS = ['summary', 'notTheirJob', 'whenToAsk'] as const;

/**
 * A custom role whose id became a built-in role's (such as `lead_developer`, which the app now
 * ships): the team's own definition is kept as the override of that built-in role, so its
 * duties and texts stay what the team wrote and its members keep the role. Where an override of the
 * built-in role exists already, the custom role's duties and texts win and the override's other
 * fields stay. The display name is dropped: a built-in role is named by the locale. Roles without
 * duties (written before duties existed) keep the built-in role's default duties.
 */
function migrateShadowingRoles(raw: unknown, { projectKey, logger }: MigrationContext): unknown {
  const team = asRecord(asRecord(raw)?.team);
  if (!team || !Array.isArray(team.roles)) return raw;
  const kept: unknown[] = [];
  const shadowing: Array<{ id: BuiltInRoleId; role: Record<string, unknown> }> = [];
  for (const entry of team.roles) {
    const role = asRecord(entry);
    const id = BuiltInRoleId.safeParse(role?.id);
    if (role && id.success) shadowing.push({ id: id.data, role });
    else kept.push(entry);
  }
  if (shadowing.length === 0) return raw;
  const overrides = asRecord(team.roleOverrides) ?? {};
  for (const { id, role } of shadowing) {
    const existing = asRecord(overrides[id]);
    const bundle: Record<string, unknown> = {
      ...existing,
      duties: role.duties ?? existing?.duties ?? BUILT_IN_ROLE_DUTIES[id],
    };
    if (typeof role.instructions === 'string' && role.instructions.trim() !== '')
      bundle.instructions = role.instructions;
    for (const field of ROLE_TEXT_FIELDS) {
      const text = role[field];
      if (typeof text === 'string' && text.trim() !== '') bundle[field] = text;
    }
    overrides[id] = bundle;
    logger.warn(
      { projectKey, role: id },
      'Migrated custom role that shadows a built-in role to a role override',
    );
  }
  team.roles = kept;
  team.roleOverrides = overrides;
  return raw;
}

/**
 * The `team.limits.messageBurst` threshold (PM-186) is gone (PM-261): it counted traffic, and the loop
 * watch that replaced it counts something else, so the value is not carried over.
 */
function dropMessageBurst(raw: unknown, { projectKey, logger }: MigrationContext): unknown {
  const limits = asRecord(asRecord(asRecord(raw)?.team)?.limits);
  if (!limits || !('messageBurst' in limits)) return raw;
  delete limits.messageBurst;
  logger.warn({ projectKey }, 'Dropped the removed message storm threshold from the team limits');
  return raw;
}

/**
 * A project without an AI project manager (PM-429) gets one, on leave until the owner calls it
 * back, sponsored by the first human owner. Without a human owner nothing is added: the
 * configuration is invalid for that reason anyway.
 */
function addProjectManager(raw: unknown, { projectKey, logger }: MigrationContext): unknown {
  const config = asRecord(raw);
  const team = asRecord(config?.team);
  if (!config || !team || !Array.isArray(team.members)) return raw;
  const members = team.members.map(asRecord).filter((m): m is Record<string, unknown> => m !== undefined);
  if (members.some((m) => isProjectManager(m as unknown as MemberConfig))) return raw;
  const owner = members.find((m) => m.kind === 'human' && m.access === 'owner');
  if (typeof owner?.handle !== 'string') return raw;
  const language = asRecord(config.project)?.language;
  const member = projectManagerMember({
    language: typeof language === 'string' ? language : DEFAULT_PROJECT_LANGUAGE,
    sponsor: owner.handle,
    taken: members.flatMap((m) => (typeof m.handle === 'string' ? [m.handle] : [])),
  });
  team.members.push({ ...member, onLeave: true });
  logger.warn({ projectKey, member: member.handle }, 'Added the required project manager, on leave');
  return raw;
}

/** Existing projects retain worker-driven handovers (PM-457). */
function addCardMover(raw: unknown): unknown {
  const team = asRecord(asRecord(raw)?.team);
  if (team && team.cardMover === undefined) team.cardMover = { kind: 'worker' };
  return raw;
}

/** Existing projects allow moves between queues as well as starting work (PM-1094). */
function addProjectManagerMoves(raw: unknown): unknown {
  const team = asRecord(asRecord(raw)?.team);
  if (team && team.projectManagerMoves === undefined)
    team.projectManagerMoves = DEFAULT_PROJECT_MANAGER_MOVES;
  return raw;
}

/** Existing projects keep today's circle: only the project managers may set a priority (PM-1096). */
function addPrioritySetters(raw: unknown): unknown {
  const team = asRecord(asRecord(raw)?.team);
  if (team && team.prioritySetters === undefined) team.prioritySetters = [...DEFAULT_PRIORITY_SETTERS];
  return raw;
}

/** Existing projects keep a viewer writing to the project manager only (PM-1102). */
function addViewerRecipients(raw: unknown): unknown {
  const team = asRecord(asRecord(raw)?.team);
  if (team && team.viewerRecipients === undefined) team.viewerRecipients = DEFAULT_VIEWER_RECIPIENTS;
  return raw;
}

/**
 * The Operator member is gone (decision 66, PM-1076): a connected Claude replaces it. A member of the
 * retired `ai_operator` role leaves the team like any retired member (the `reconcile` listener records it
 * as retired, its handle is never reused and its old events keep showing the handle), together with the
 * references to it: the contacts, the stage owners, the role override and the temp workers' role. Runs on
 * every read, so an earlier version restored from history loses it as well and the removed `addOperator`
 * and `fixOperator` cannot bring it back; a second run changes nothing.
 */
function removeOperator(raw: unknown, { projectKey, logger }: MigrationContext): unknown {
  const config = asRecord(raw);
  const team = asRecord(config?.team);
  if (!config || !team || !Array.isArray(team.members)) return raw;
  const gone = new Set<string>();
  for (const member of rawAiMembers(raw)) {
    if (member.role === RETIRED_OPERATOR_ROLE && typeof member.handle === 'string') gone.add(member.handle);
  }
  if (gone.size) {
    const remaining = team.members.filter(
      (m) => !(asRecord(m)?.kind === 'ai' && gone.has(String(asRecord(m)?.handle))),
    );
    team.members = remaining;
    if (Array.isArray(team.contacts)) team.contacts = team.contacts.filter((h) => !gone.has(String(h)));
    const pipeline = asRecord(config.pipeline);
    if (Array.isArray(pipeline?.stages)) {
      for (const stage of pipeline.stages.map(asRecord)) {
        if (stage && Array.isArray(stage.owners))
          stage.owners = stage.owners.filter((h) => !gone.has(String(h)));
      }
    }
    // A label the Operator could set by name: the other setters stay. A label nobody else could set falls to
    // the owners in person (an empty `setBy` does not parse), or to the system when there is no owner: no
    // narrower rule loads, and no one gains the right.
    const owners = remaining.flatMap((m) => {
      const member = asRecord(m);
      return member?.kind === 'human' && member.access === 'owner' && typeof member.handle === 'string'
        ? [member.handle]
        : [];
    });
    if (Array.isArray(pipeline?.labels)) {
      for (const label of pipeline.labels.map(asRecord)) {
        const setBy = asRecord(label?.setBy);
        if (!label || !setBy || !Array.isArray(setBy.members)) continue;
        const members = setBy.members.filter((h) => !gone.has(String(h)));
        if (members.length === setBy.members.length) continue;
        if (members.length) setBy.members = members;
        else if (Array.isArray(setBy.duties) && setBy.duties.length) delete setBy.members;
        else label.setBy = owners.length ? { members: owners, humansOnly: true } : 'system';
      }
    }
    // A merger naming the Operator was never valid; dropped, `addMerger` (next in the chain) derives the default.
    const merger = asRecord(team.merger);
    if (merger?.kind === 'member' && gone.has(String(merger.handle))) delete team.merger;
    logger.warn({ projectKey, members: [...gone] }, 'Removed the retired Operator member');
  }
  const overrides = asRecord(team.roleOverrides);
  if (overrides && overrides[RETIRED_OPERATOR_ROLE] !== undefined) {
    delete overrides[RETIRED_OPERATOR_ROLE];
    logger.warn({ projectKey, fields: ['roleOverrides.ai_operator'] }, 'Removed the retired Operator role');
  }
  const tempWorkers = asRecord(asRecord(team.limits)?.tempWorkers);
  if (tempWorkers && tempWorkers.role === RETIRED_OPERATOR_ROLE) {
    tempWorkers.role = 'developer';
    logger.warn({ projectKey, fields: ['limits.tempWorkers.role'] }, 'Removed the retired Operator role');
  }
  return raw;
}

/**
 * A project without a merger (PM-470) gets the one its pipeline implies: the code reviewer when a code
 * review stage comes before the merge target, else the developer. A configuration that does not parse is
 * left alone: at run time the same rule (`mergerOf`) applies to the missing value.
 */
function addMerger(raw: unknown): unknown {
  const team = asRecord(asRecord(raw)?.team);
  if (!team || team.merger !== undefined) return raw;
  const parsed = ProjectConfig.safeParse(raw);
  if (parsed.success) team.merger = defaultMerger(parsed.data);
  return raw;
}

/**
 * The project manager role (PM-506) carries the feedback processing duty. A built-in role without an
 * override gets it from the defaults; an override replaces the whole bundle, so the duty is appended
 * to the override's list when it is missing. Idempotent.
 */
function addFeedbackProcessing(raw: unknown, { projectKey, logger }: MigrationContext): unknown {
  const override = asRecord(asRecord(asRecord(asRecord(raw)?.team)?.roleOverrides)?.project_manager);
  if (!override || !Array.isArray(override.duties) || override.duties.includes('feedback_processing'))
    return raw;
  override.duties.push('feedback_processing');
  logger.warn(
    { projectKey, fields: ['roleOverrides.project_manager.duties'] },
    'Added the feedback processing duty to the project manager role override',
  );
  return raw;
}

/**
 * A project that has temp workers settings (PM-1101) gets the explicit default card limit, so choosing
 * the default later is no change in the canonical comparison. A set value stays; a project without the
 * section gets the schema default. Idempotent.
 */
function addTempMaxPoints(raw: unknown): unknown {
  const tempWorkers = asRecord(asRecord(asRecord(asRecord(raw)?.team)?.limits)?.tempWorkers);
  if (tempWorkers && tempWorkers.maxPoints === undefined) tempWorkers.maxPoints = DEFAULT_TEMP_MAX_POINTS;
  return raw;
}

/**
 * Upgrades a merged, not yet validated project configuration of an older shape, in memory: the
 * customization files keep their content until the next save. Used wherever the store reads
 * a configuration (the working tree and earlier versions alike).
 *   - a custom role with a built-in role's id becomes that role's override (above);
 *   - the removed `scheduled` AI role becomes `maintainer` (above);
 *   - a Codex member in `bypassPermissions` becomes `acceptEdits` (above);
 *   - gate conditions from before labels (check_passed, pr_merged, human_approval) become label
 *     conditions with the labels they need (`migrateLegacyConfig`, @projectman/templates);
 *   - a label a release gate requires that more than the release approval duty's holders may set
 *     is narrowed to that duty (above), after the conversion of legacy gates;
 *   - the removed separate mailbox name (`email.mailbox`, PM-1039) is dropped from every AI member (above);
 *   - the removed message storm threshold (`messageBurst`) is dropped (above);
 *   - a project without an AI project manager gets one, on leave (above);
 *   - a missing card mover becomes worker (above);
 *   - missing project manager moves allow queue moves and starting work (above);
 *   - a missing priority setting becomes the project managers (above);
 *   - a missing viewer recipients setting becomes the project manager only (above);
 *   - the retired Operator member (`ai_operator`) leaves the team, with its role override and its
 *     references (above), and is never put back;
 *   - a missing merger becomes the code reviewer or the developer, by the pipeline (above), judged on
 *     the configuration without the Operator;
 *   - an override of the project manager role gets the feedback processing duty (above);
 *   - a temp workers section without a card limit gets `DEFAULT_TEMP_MAX_POINTS` (above), last.
 * Stage kinds from before decision 18 (review, deploy, …) are read by the pipeline schema
 * itself (packages/shared/src/domain/pipeline.ts).
 */
export function migrateProjectConfig(raw: unknown, context: MigrationContext): unknown {
  return addTempMaxPoints(
    addFeedbackProcessing(
      addMerger(
        removeOperator(
          addViewerRecipients(
            addPrioritySetters(
              addProjectManagerMoves(
                addCardMover(
                  addProjectManager(
                    migrateReleaseApproval(
                      migrateLegacyConfig(
                        migrateCodexBypass(
                          migrateScheduledRole(
                            dropMessageBurst(
                              migrateSeniorLimit(
                                dropEmailMailbox(migrateShadowingRoles(raw, context), context),
                                context,
                              ),
                              context,
                            ),
                            context,
                          ),
                          context,
                        ),
                      ),
                      context,
                    ),
                    context,
                  ),
                ),
              ),
            ),
          ),
          context,
        ),
      ),
      context,
    ),
  );
}
