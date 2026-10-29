export function createMemberService(deps: ConstructorParameters<typeof MemberService>[0]): MemberService {
  return new MemberService(deps);
}

import {
  AiMemberConfig,
  AgentProvider,
  MemberQuotaWaiting,
  DEFAULT_OUTBOUND_NETWORK,
  HumanMemberConfig,
  DEFAULT_AGENT_PROVIDER,
  modelForProvider,
  canSeeOperatorSessions,
  holdersAllow,
  isRequiredProjectManager,
  isDeveloper,
  isComplexityPoints,
  complexityLimitOf,
  MemberHandle,
  memberStorageHandle,
  renameMemberInConfig,
  RETIRED_OPERATOR_HANDLE,
  memberDuties,
  memberOf,
  memberRoles,
  approverBlocker,
  permissionView,
  roleHolders,
  stageApprovers,
  stageOf,
  stagesToJoin,
  taskSeq,
  taskWorkOf,
  LIVE_SESSION_STATES,
} from '@projectman/shared';
import type {
  Actor,
  AddHumanMemberRequest,
  HireMemberRequest,
  MemberProfile,
  MemberStatus,
  MemberUsage,
  MemberView,
  WorkOutage,
  ProjectConfig,
  SessionState,
  TaskKey,
  UpdateMemberRequest,
  OperatorMemberChanges,
} from '@projectman/shared';
import { aiMemberDefaults } from '@projectman/templates';
import type { MemberCapacity, MemberProfileSessions, MemberRenameRuntime } from './ports';
import { findHumanByEmail, requireAiMember, requireHuman } from './access';
import {
  applyMemberEmailChange,
  emailMailboxOf,
  emailMailboxReserved,
  emailMailboxTaken,
  machineAccessOf,
  ownerHandles,
} from '@projectman/shared';
import type { ProjectAccess } from './access';
import { isoNow } from '../base';
import type { DomainContext } from '../base';
import { conflict, DomainError, invalid, notFound } from '../../kernel';
import type { InboxService } from '../inbox';
import { defaultMemberHandle, defaultMemberName, humanMemberHandle } from './naming';
import type { PresenceService } from './presence';
import type { Author, ConfigChange, ProjectService } from '../projects';
import { isOpenTask, isTheme } from '@projectman/shared';
import type { TaskService } from '../tasks';
import type { TimelineService } from '../timeline';
import { unique } from '../../kernel';
import { visibleSession, visibleTimelineEvent } from '../projects';
import type { Viewer } from '../projects';

const ENDED_SESSION_STATES = new Set<SessionState>(['exited', 'failed']);

/** Throws unless a member of this kind may hold the role (a built-in or one of the team's custom roles). */
export function assertRoleFor(config: ProjectConfig, role: string, kind: 'human' | 'ai'): void {
  const holders = roleHolders(role, config.team.roles, config.team.roleOverrides);
  if (holders === null) throw invalid('unknown_role', `unknown role: ${role}`, { role });
  if (!holdersAllow(holders, kind)) {
    throw kind === 'ai'
      ? invalid('role_not_for_ai', `only humans can hold the role ${role}`, { role })
      : invalid('role_not_for_human', `only AI members can hold the role ${role}`, { role });
  }
}

/**
 * The roster (configured members + runtime state), hiring and retiring. Hiring and retiring
 * are configuration changes (commits in the customization repository).
 */
export class MemberService {
  private readonly ctx: DomainContext;
  private readonly projects: ProjectService;
  private readonly timeline: TimelineService;
  private readonly presence: PresenceService;
  private readonly inbox: InboxService;
  private readonly outageOf?: (projectKey: string, handle: string) => WorkOutage | undefined;
  private renameRuntime?: MemberRenameRuntime;

  constructor(deps: {
    ctx: DomainContext;
    projects: ProjectService;
    timeline: TimelineService;
    presence: PresenceService;
    inbox: InboxService;
    outageOf?: (projectKey: string, handle: string) => WorkOutage | undefined;
  }) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.timeline = deps.timeline;
    this.presence = deps.presence;
    this.inbox = deps.inbox;
    this.outageOf = deps.outageOf;
  }

  async roster(projectKey: string): Promise<MemberView[]> {
    return this.rosterFor(await this.projects.config(projectKey));
  }

  async publishMembers(projectKey: string, handles: string[]): Promise<void> {
    const roster = await this.roster(projectKey);
    for (const handle of handles) {
      const member = roster.find((m) => m.handle === handle) ?? null;
      this.ctx.bus.publish({ type: 'member_changed', projectKey, handle, member });
    }
  }

  /** Every member's whole state. */
  rosterFor(config: ProjectConfig): MemberView[] {
    const projectKey = config.project.key;
    const openTasks = new Map(
      this.ctx.repos.tasks
        // Only the open cards count (PM-771): the closed history is never loaded for a roster.
        .readScheduling(projectKey, { kind: 'open' })
        // A theme is carried by nobody and never counts as work (PM-192).
        .filter((t) => isOpenTask(t) && !isTheme(t))
        .map((t) => [t.key, t]),
    );
    const sessions = this.ctx.repos.sessions
      .listInStates([...LIVE_SESSION_STATES])
      .filter((s) => s.projectKey === projectKey);
    const states = new Map(this.ctx.repos.memberState.list(projectKey).map((s) => [s.handle, s]));

    return config.team.members.map((m): MemberView => {
      const keys = new Set<string>();
      for (const task of openTasks.values()) if (task.assignee === m.handle) keys.add(task.key);
      for (const s of sessions) {
        if (s.member !== m.handle || s.workItem.type !== 'task' || ENDED_SESSION_STATES.has(s.state))
          continue;
        if (openTasks.has(s.workItem.taskKey)) keys.add(s.workItem.taskKey);
      }
      const currentTaskKeys = [...keys].sort((a, b) => taskSeq(a) - taskSeq(b));
      const taskWork = sessions
        .filter((s) => s.member === m.handle)
        .flatMap((s) => taskWorkOf(s) ?? [])
        .filter((work) => openTasks.has(work.taskKey))
        .sort((a, b) => taskSeq(a.taskKey) - taskSeq(b.taskKey));
      if (m.kind === 'human') {
        return {
          handle: m.handle,
          displayName: m.displayName,
          githubLogin: m.githubLogin,
          kind: 'human',
          role: m.access,
          roles: m.roles,
          specialty: null,
          status: !m.email ? 'no_account' : this.presence.isOnline(m.email) ? 'online' : 'offline',
          activity: null,
          activityTaskKey: null,
          currentTaskKeys,
          sponsor: null,
          temp: false,
        };
      }
      const state = states.get(m.handle);
      const quotaWaiting = this.ctx.repos.memberQueue
        .listOpen(projectKey, m.handle)
        .flatMap((item) => {
          const reason = MemberQuotaWaiting.shape.reason.safeParse(item.wait?.code);
          if (item.state !== 'queued' || !item.wake || !item.wait || !reason.success) return [];
          const provider = AgentProvider.safeParse(item.waitDetails?.provider);
          const until = item.waitDetails?.until;
          return [
            {
              reason: reason.data,
              since: item.wait.at,
              ...(provider.success ? { provider: provider.data } : {}),
              ...(typeof until === 'string' ? { until } : {}),
            },
          ];
        })
        .sort((a, b) => a.since.localeCompare(b.since))[0];
      return {
        handle: m.handle,
        displayName: m.displayName,
        githubLogin: m.githubLogin,
        kind: 'ai',
        ...(m.formerHandles?.length ? { formerHandles: m.formerHandles } : {}),
        email: {
          enabled: m.email?.enabled ?? false,
          sendWithoutApproval: m.email?.sendWithoutApproval ?? false,
        },
        outage: this.outageOf?.(projectKey, m.handle),
        quotaWaiting,
        role: m.role,
        roles: memberRoles(m),
        specialty: m.specialty ?? null,
        status: state && state.status !== 'retired' ? state.status : 'idle',
        activity: state?.activity ?? null,
        activityTaskKey: state?.activityTaskKey ?? null,
        currentTaskKeys,
        taskWork,
        sponsor: m.sponsor,
        temp: m.temp,
        provider: m.provider ?? DEFAULT_AGENT_PROVIDER,
        model: m.model,
        effort: m.effort,
        ...(m.autoCompactWindowTokens ? { autoCompactWindowTokens: m.autoCompactWindowTokens } : {}),
        ...(m.cheapSubagent ? { cheapSubagent: m.cheapSubagent } : {}),
        ...permissionView(config, m),
        machineAccess: machineAccessOf(m),
        ...(m.onLeave ? { onLeave: true } : {}),
        ...(isDeveloper(config, m) ? { complexityLimit: complexityLimitOf(config, m) } : {}),
        ...(isDeveloper(config, m) && m.specialtyLabels ? { specialtyLabels: m.specialtyLabels } : {}),
      };
    });
  }

  /**
   * Sponsor of an AI member hired (or a temp worker started) on a human's request: the requester
   * when they are an owner, otherwise the first owner (in v1 every AI member runs on the owner's
   * subscription).
   */
  async sponsorFor(requester: ProjectAccess): Promise<string> {
    if (requester.access === 'owner') return requester.handle;
    return ownerHandles(await this.projects.config(requester.projectKey))[0] ?? requester.handle;
  }

  /** Handles of the team's human members. */
  async humanHandles(projectKey: string): Promise<string[]> {
    const config = await this.projects.config(projectKey);
    return config.team.members.filter((m) => m.kind === 'human').map((m) => m.handle);
  }

  /** Handles in use now or in the past (config, runtime state incl. retired, sessions). */
  takenHandles(projectKey: string, config: ProjectConfig): Set<string> {
    // The retired Operator's handle stays reserved: its old events and messages keep showing it (PM-1076).
    const taken = new Set([RETIRED_OPERATOR_HANDLE, ...config.team.members.map((m) => m.handle)]);
    // A renamed member keeps its old handles (PM-1025); the events cover a rename whose configuration was reverted.
    for (const m of config.team.members)
      for (const former of m.kind === 'ai' ? (m.formerHandles ?? []) : []) taken.add(former);
    for (const e of this.ctx.repos.timeline.ofProjectType(projectKey, 'member_renamed', 1000))
      taken.add((e.data as { from: string }).from);
    for (const s of this.ctx.repos.memberState.list(projectKey)) taken.add(s.handle);
    for (const member of this.ctx.repos.sessions.members(projectKey)) taken.add(member);
    return taken;
  }

  async addHuman(
    projectKey: string,
    req: AddHumanMemberRequest,
    by: { actor: Actor; author: Author },
  ): Promise<MemberView> {
    let handle = '';
    await this.projects.update(projectKey, by, (draft) => {
      requireHuman(draft, by.actor, 'admin', { message: 'owner or admin required' });
      for (const role of req.roles) assertRoleFor(draft, role, 'human');
      const taken = this.takenHandles(projectKey, draft);
      if (req.handle && taken.has(req.handle))
        throw conflict('handle_taken', `handle already used: ${req.handle}`);
      handle = req.handle ?? humanMemberHandle(req.displayName, taken);
      draft.team.members.push(
        HumanMemberConfig.parse({
          kind: 'human',
          handle,
          displayName: req.displayName,
          access: req.access,
          roles: unique(req.roles),
        }),
      );
      return `Add human member ${handle} without account`;
    });
    return (await this.roster(projectKey)).find((member) => member.handle === handle)!;
  }

  /**
   * Hires an AI member for any role an AI may hold (built-in or custom) with the role's
   * defaults; `sponsor` is the human whose subscription runs it.
   */
  async hire(
    projectKey: string,
    req: HireMemberRequest,
    by: { actor: Actor; author: Author; sponsor: string },
    opts: { temp?: boolean; stageId?: string } = {},
  ): Promise<AiMemberConfig> {
    let hired: AiMemberConfig | null = null;
    await this.projects.update(projectKey, { actor: by.actor, author: by.author }, (draft) => {
      const prepared = this.prepareHire(projectKey, draft, req, by.sponsor, opts);
      hired = prepared.member;
      return prepared.message;
    });
    const member = hired as AiMemberConfig | null;
    if (!member) throw new Error('hire did not produce a member');
    this.timeline.append({
      projectKey,
      actor: by.actor,
      type: 'member_hired',
      data: { handle: member.handle, role: member.role, temp: member.temp, sponsor: member.sponsor },
    });
    return member;
  }

  /** Mutates only the in-memory draft; shared by execution and Operator previews. */
  prepareHire(
    projectKey: string,
    draft: ProjectConfig,
    req: HireMemberRequest,
    sponsorHandle: string,
    opts: { temp?: boolean; stageId?: string } = {},
  ): { member: AiMemberConfig; message: string } {
    assertRoleFor(draft, req.role, 'ai');
    const defaults = aiMemberDefaults(req.role, draft.team.roles, draft.team.roleOverrides);
    if (!defaults) throw invalid('role_not_for_ai', `no AI member can hold the role ${req.role}`);
    const sponsor = memberOf(draft, sponsorHandle);
    if (!sponsor || sponsor.kind !== 'human') {
      throw invalid('invalid_sponsor', `sponsor must be a human member: ${sponsorHandle}`);
    }
    const taken = this.takenHandles(projectKey, draft);
    if (req.handle && taken.has(req.handle))
      throw conflict('handle_taken', `handle already used: ${req.handle}`);
    const handle = req.handle ?? defaultMemberHandle(req.role, taken, req.specialty);
    if (!MemberHandle.safeParse(handle).success || taken.has(handle)) {
      throw conflict('handle_taken', `no free handle for role ${req.role}`);
    }
    const specialty = req.specialty?.trim() ?? '';
    const index =
      draft.team.members.filter(
        (m) => m.kind === 'ai' && m.role === req.role && (m.specialty ?? '').trim() === specialty,
      ).length + 1;
    const member = AiMemberConfig.parse({
      kind: 'ai',
      handle,
      displayName:
        req.displayName?.trim() ||
        defaultMemberName(req.role, draft.project.language, index, {
          specialty: specialty || undefined,
          customRoles: draft.team.roles,
        }),
      role: req.role,
      ...(req.specialty ? { specialty: req.specialty } : {}),
      ...(req.provider ? { provider: req.provider } : {}),
      model:
        req.provider && req.provider !== 'claude'
          ? modelForProvider(req.provider, req.model)
          : (req.model ?? defaults.model),
      ...(req.effort ? { effort: req.effort } : {}),
      ...(req.cheapSubagent ? { cheapSubagent: req.cheapSubagent } : {}),
      permissionMode: defaults.permissionMode,
      approver: defaults.approver,
      capacity: defaults.capacity,
      instructions: defaults.instructions,
      sponsor: sponsor.handle,
      temp: opts.temp ?? false,
      ...(req.schedule ? { schedule: req.schedule } : {}),
      outboundNetwork: req.outboundNetwork ?? DEFAULT_OUTBOUND_NETWORK,
      // Explicit, so a new member never takes the role's default: the owner switches it on (decision 66).
      machineAccess: false,
    });
    draft.team.members.push(member);
    if (opts.temp && opts.stageId) {
      const stage = stageOf(draft, opts.stageId);
      if (stage?.owners) stage.owners = [...stage.owners, handle];
    } else if (!opts.temp) {
      for (const stage of stagesToJoin(draft, member)) stage.owners = [...(stage.owners ?? []), handle];
    }
    return {
      member,
      message: opts.temp ? `Hire temporary ${req.role} ${handle}` : `Hire ${req.role} ${handle}`,
    };
  }

  /**
   * Changes a member (a configuration commit): the display name of anyone, the roles a human
   * holds, and an AI member's settings, capacity and single role.
   */
  async update(
    projectKey: string,
    handle: string,
    req: UpdateMemberRequest | OperatorMemberChanges,
    by: { actor: Actor; author: Author },
  ): Promise<MemberView> {
    await this.projects.update(projectKey, by, (draft) => this.prepareUpdate(draft, handle, req));
    const view = (await this.roster(projectKey)).find((m) => m.handle === handle);
    if (!view) throw notFound('member', handle);
    return view;
  }

  /**
   * 409 `email_mailbox_taken` when another AI member, in this or any other project, has this handle as its
   * address (PM-989, PM-1039). `reserved` checks only the handles other members were renamed from (PM-1025):
   * a member that switches its address on may share a live handle, as before, but never a former one.
   */
  private assertMailboxFree(
    draft: ProjectConfig,
    handle: string,
    mailbox: string,
    scope: 'any' | 'reserved' = 'any',
  ): void {
    const others = this.projects
      .summaries()
      .filter((project) => project.key !== draft.project.key)
      .flatMap((project) => this.projects.cachedConfig(project.key) ?? []);
    const taken = scope === 'any' ? emailMailboxTaken : emailMailboxReserved;
    if (taken([draft, ...others], draft.project.key, handle, mailbox))
      throw conflict('email_mailbox_taken', `the address ${mailbox} is taken`, { mailbox });
  }

  /** Mutates only the in-memory draft; shared by execution and Operator previews. */
  prepareUpdate(
    draft: ProjectConfig,
    handle: string,
    req: Omit<UpdateMemberRequest, 'permissionMode'> & Partial<OperatorMemberChanges>,
  ): string {
    const member = memberOf(draft, handle);
    if (!member) throw notFound('member', handle);
    const fields: string[] = [];
    if (member.kind === 'human') {
      if (req.access !== undefined) {
        member.access = req.access;
        fields.push('access');
      }
      if (
        req.specialty !== undefined ||
        req.specialtyLabels !== undefined ||
        req.model !== undefined ||
        req.schedule !== undefined ||
        req.provider !== undefined ||
        req.effort !== undefined ||
        req.autoCompactWindowTokens !== undefined ||
        req.cheapSubagent !== undefined ||
        req.onLeave !== undefined ||
        req.instructions !== undefined ||
        req.permissionMode !== undefined ||
        req.capacity !== undefined ||
        req.role !== undefined ||
        req.approver !== undefined ||
        req.outboundNetwork !== undefined ||
        req.machineAccess !== undefined ||
        req.email !== undefined
      ) {
        throw invalid(
          'not_ai_member',
          'specialty, specialty labels, provider, model, effort, compaction window, cheap subagent, schedule, leave, instructions, permission mode, approver, outbound network, machine access and email settings apply to AI members only',
        );
      }
      if (req.roles !== undefined) {
        const roles = [...new Set(req.roles)];
        for (const role of roles) assertRoleFor(draft, role, 'human');
        member.roles = roles;
        fields.push('roles');
      }
    } else {
      if (req.access !== undefined) throw invalid('not_human_member', 'Access applies to humans');
      if (req.roles !== undefined) {
        throw invalid('not_human_member', 'an AI member holds exactly one role; roles apply to humans');
      }
      if (req.specialty !== undefined) {
        const specialty = req.specialty.trim();
        if (specialty) member.specialty = specialty;
        else delete member.specialty;
        fields.push('specialty');
      }
      if (req.model !== undefined) {
        member.model = req.model;
        fields.push('model');
      }
      if (req.provider !== undefined && req.provider !== (member.provider ?? DEFAULT_AGENT_PROVIDER)) {
        member.provider = req.provider;
        member.model = modelForProvider(req.provider, req.model);
        fields.push('provider');
      }
      if (req.effort !== undefined) {
        if (req.effort === null) delete member.effort;
        else member.effort = req.effort;
        fields.push('effort');
      }
      // Kept for a Codex member too, where it has no effect.
      if (req.autoCompactWindowTokens !== undefined) {
        if (req.autoCompactWindowTokens === null) delete member.autoCompactWindowTokens;
        else member.autoCompactWindowTokens = req.autoCompactWindowTokens;
        fields.push('compaction window');
      }
      // Kept for a Codex member too, where it has no effect (`cheapSubagentOf`).
      if (req.cheapSubagent !== undefined) {
        if (req.cheapSubagent === null) delete member.cheapSubagent;
        else member.cheapSubagent = req.cheapSubagent;
        fields.push('cheap subagent');
      }
      if (req.schedule !== undefined) {
        if (req.schedule) member.schedule = req.schedule;
        else delete member.schedule;
        fields.push('schedule');
      }
      if (req.instructions !== undefined) {
        member.instructions = req.instructions.trim();
        fields.push('instructions');
      }
      // Who may change the mode and the approver is `ownerOnlyChanges` (category `permissions`),
      // checked on the commit.
      if (req.capacity !== undefined) {
        member.capacity = req.capacity;
        fields.push('capacity');
      }
      if (req.role !== undefined) {
        assertRoleFor(draft, req.role, 'ai');
        // The role sets the machine access default: pin the effective value so a role change keeps it.
        member.machineAccess ??= machineAccessOf(member);
        member.role = req.role;
        fields.push('role');
      }
      if (req.machineAccess !== undefined) {
        member.machineAccess = req.machineAccess;
        fields.push('machine access');
      }
      if (req.permissionMode !== undefined) {
        member.permissionMode = req.permissionMode;
        fields.push('permission mode');
      }
      if (req.approver !== undefined) {
        const blocker = approverBlocker(draft, handle, req.approver);
        if (blocker) {
          throw new DomainError(
            'approver_unavailable',
            `the approver ${req.approver} is not available: ${blocker}`,
            { status: 422, details: { blocker } },
          );
        }
        member.approver = req.approver;
        fields.push('approver');
      }
      if (req.outboundNetwork !== undefined) {
        member.outboundNetwork = req.outboundNetwork;
        fields.push('outbound network');
      }
      if (req.email !== undefined) {
        const wasEnabled = member.email?.enabled === true;
        member.email = applyMemberEmailChange(member.email, req.email);
        if (!wasEnabled && member.email.enabled)
          this.assertMailboxFree(draft, handle, emailMailboxOf(member), 'reserved');
        fields.push('email');
      }
      if (req.onLeave !== undefined) {
        if (req.onLeave) member.onLeave = true;
        else delete member.onLeave;
        fields.push(req.onLeave ? 'sent on leave' : 'called back from leave');
      }
    }
    if (req.specialtyLabels !== undefined) {
      if (member.kind !== 'ai' || member.temp || !isDeveloper(draft, member))
        throw invalid(
          'specialty_labels_not_developer',
          'only permanent AI developers have configurable specialty labels',
        );
      const labels = [...new Set(req.specialtyLabels?.map((label) => label.trim()) ?? [])];
      if (labels.length === 0) delete member.specialtyLabels;
      else member.specialtyLabels = labels;
      fields.push('specialty labels');
    }
    if (req.complexityLimit !== undefined) {
      if (member.kind !== 'ai' || member.temp || !isDeveloper(draft, member))
        throw invalid(
          'complexity_limit_not_developer',
          'only permanent AI developers have a configurable complexity limit',
        );
      if (req.complexityLimit !== null && !isComplexityPoints(req.complexityLimit))
        throw invalid('complexity_points_invalid', 'complexity limit must be 1, 2, 3, 5, 8 or 13');
      if (req.complexityLimit === null) delete member.complexityLimit;
      else member.complexityLimit = req.complexityLimit;
      fields.push('complexity limit');
    }
    if (req.displayName !== undefined) {
      member.displayName = req.displayName;
      fields.push('display name');
    }
    return `Update ${handle}${fields.length > 0 ? `: ${fields.join(', ')}` : ''}`;
  }

  /**
   * Retires an AI member: its stage ownerships move to `handoverTo`; the configuration change
   * listeners hand its open tasks to `handoverTo` (or unassign them) and stop its sessions.
   */
  async retire(
    projectKey: string,
    handle: string,
    opts: { handoverTo?: string },
    by: { actor: Actor; author: Author },
  ): Promise<void> {
    const config = await this.projects.config(projectKey);
    requireAiMember(config, handle);
    if (isRequiredProjectManager(config, handle)) {
      throw conflict(
        'project_manager_required',
        'the only AI project manager cannot be retired; hire another one first',
      );
    }
    const handoverTo = opts.handoverTo ?? null;
    if (handoverTo !== null) {
      if (handoverTo === handle) throw invalid('invalid_request', 'cannot hand over to the retiring member');
      if (!memberOf(config, handoverTo)) throw notFound('member', handoverTo);
    }

    const handovers = handoverTo ? { [handle]: handoverTo } : undefined;
    await this.projects.update(projectKey, { ...by, handovers }, (draft) => {
      this.prepareRetire(draft, handle, handoverTo);
      return `Retire ${handle}${handoverTo ? ` (handover to ${handoverTo})` : ''}`;
    });
    await this.inbox.cancelOpenFromSource(projectKey, handle);

    this.timeline.append({
      projectKey,
      actor: by.actor,
      type: 'member_retired',
      data: { handle, handoverTo },
    });
  }

  /** Mutates only the draft; the commit listeners perform the handovers and stops. */
  prepareRetire(draft: ProjectConfig, handle: string, handoverTo: string | null = null): void {
    requireAiMember(draft, handle);
    draft.team.members = draft.team.members.filter((m) => m.handle !== handle);
    draft.team.contacts = (draft.team.contacts ?? []).filter((contact) => contact !== handle);
    for (const stage of draft.pipeline.stages) {
      if (!(stage.owners ?? []).includes(handle)) continue;
      stage.owners = unique(
        (stage.owners ?? []).flatMap((h) => (h === handle ? (handoverTo ? [handoverTo] : []) : [h])),
      );
    }
  }

  /** Binds what a handle rename needs from the runtime (built after this service). */
  useRenameRuntime(runtime: MemberRenameRuntime): void {
    this.renameRuntime = runtime;
  }

  /**
   * Renames an AI member (PM-1025): the handle, and with it every operational reference, is the new one; the
   * timeline and the storage keys (`memberStorageHandle`) stay. Refused while anything of the member runs. The
   * member's starts are held back from the validation to the announcement, and the validation runs again under
   * the configuration lock, so nothing starts under the old handle in between.
   */
  async rename(
    projectKey: string,
    handle: string,
    to: string,
    by: { actor: Actor; author: Author },
  ): Promise<MemberView> {
    requireAiMember(await this.projects.config(projectKey), handle);
    const release = this.renameRuntime?.holdStarts(projectKey, handle);
    try {
      await this.projects.update(projectKey, { ...by, renames: { [handle]: to } }, (draft) => {
        this.prepareRename(projectKey, draft, handle, to);
        return `Rename ${handle} to ${to}`;
      });
    } finally {
      release?.();
    }
    const view = (await this.roster(projectKey)).find((m) => m.handle === to);
    if (!view) throw notFound('member', to);
    return view;
  }

  /** Mutates only the draft; the commit rewrites the database and tells the listeners. */
  prepareRename(projectKey: string, draft: ProjectConfig, handle: string, to: string): void {
    const member = requireAiMember(draft, handle);
    if (!MemberHandle.safeParse(to).success) throw invalid('invalid_request', `invalid handle: ${to}`);
    if (to === handle || this.takenHandles(projectKey, draft).has(to))
      throw conflict('handle_taken', `handle already used: ${to}`);
    if (member.email?.enabled) this.assertMailboxFree(draft, handle, to);
    else this.assertMailboxFree(draft, handle, to, 'reserved');
    this.assertIdle(projectKey, member);
    Object.assign(draft, renameMemberInConfig(draft, handle, to));
  }

  /** 409 `member_session_live` while a session, a workspace, a queue item or a deferred start still holds the handle. */
  private assertIdle(projectKey: string, member: AiMemberConfig): void {
    const { repos } = this.ctx;
    const handle = member.handle;
    const busy = (reason: 'session' | 'workspace' | 'queue' | 'deferred_start'): DomainError =>
      conflict('member_session_live', `${handle} is working: ${reason}`, { reason, member: handle });
    if (
      repos.sessions
        .list(projectKey)
        .some((s) => s.member === handle && LIVE_SESSION_STATES.includes(s.state))
    )
      throw busy('session');
    if (repos.memberWorkspaces.listOfMember(projectKey, memberStorageHandle(member)).some((w) => w.holder))
      throw busy('workspace');
    if (repos.memberQueue.listOpen(projectKey, handle).some((item) => item.state === 'processing'))
      throw busy('queue');
    if (this.renameRuntime?.deferredStartNames(projectKey, handle)) throw busy('deferred_start');
  }

  async removeHuman(projectKey: string, handle: string, by: { actor: Actor; author: Author }): Promise<void> {
    await this.projects.update(projectKey, by, (draft) => {
      const member = memberOf(draft, handle);
      if (!member) throw notFound('member', handle);
      if (member.kind !== 'human') throw invalid('not_human_member', 'Only humans can be removed');
      draft.team.members = draft.team.members.filter((m) => m.handle !== handle);
      draft.team.contacts = (draft.team.contacts ?? []).filter((contact) => contact !== handle);
      // Sponsors and explicit gate approvers must be reassigned before removal.
      for (const stage of draft.pipeline.stages) {
        if (stage.owners) stage.owners = stage.owners.filter((h) => h !== handle);
      }
      return `Remove human member ${handle}`;
    });
    this.inbox.reassignRemovedHuman(projectKey, handle, ownerHandles(await this.projects.config(projectKey)));
  }

  /** Records an AI member's runtime status; retired members stay retired. */
  setState(
    projectKey: string,
    handle: string,
    status: MemberStatus,
    activity: string | null,
    activityTaskKey: TaskKey | null,
  ): void {
    const current = this.ctx.repos.memberState.get(projectKey, handle);
    if (current?.status === 'retired') return;
    if (
      current &&
      current.status === status &&
      current.activity === activity &&
      current.activityTaskKey === activityTaskKey
    )
      return;
    this.writeState(projectKey, handle, status, activity, activityTaskKey);
  }

  /**
   * Startup, before anything reads the database: a rename whose configuration was saved but whose database step
   * did not finish (PM-1025). Every link of a member's chain of former handles (a -> b -> c) without its
   * `member_renamed` event is rewritten again (the rewrite is idempotent) and recorded.
   */
  recoverRenames(): void {
    const { repos } = this.ctx;
    for (const project of repos.projects.list()) {
      const config = this.projects.cachedConfig(project.key);
      if (!config) continue;
      const done = new Set(
        repos.timeline
          .ofProjectType(project.key, 'member_renamed', 1000)
          .map((e) => `${(e.data as { from: string }).from}\n${(e.data as { to: string }).to}`),
      );
      for (const member of config.team.members) {
        if (member.kind !== 'ai' || !member.formerHandles?.length) continue;
        const chain = [...member.formerHandles, member.handle];
        for (let i = 0; i + 1 < chain.length; i++) {
          const [from, to] = [chain[i]!, chain[i + 1]!];
          if (done.has(`${from}\n${to}`)) continue;
          this.ctx.unitOfWork(() => {
            repos.memberHandles.rename(project.key, from, to);
            this.timeline.append({
              projectKey: project.key,
              actor: { kind: 'system', handle: null },
              type: 'member_renamed',
              data: { from, to, version: project.configVersion },
            });
          });
        }
      }
    }
  }

  /** Startup: no session survived the restart, so no AI member is working or waiting. */
  reconcileAfterRestart(): void {
    for (const project of this.ctx.repos.projects.list()) {
      for (const state of this.ctx.repos.memberState.list(project.key)) {
        this.setState(project.key, state.handle, 'idle', null, null);
      }
    }
  }

  /** Config change listener: new AI members start idle, removed ones become retired. */
  reconcile(change: ConfigChange): void {
    const { projectKey, previous, next } = change;
    const nextHandles = new Set(next.team.members.map((m) => m.handle));
    this.ctx.unitOfWork(() => {
      for (const m of next.team.members) {
        if (m.kind !== 'ai') continue;
        const state = this.ctx.repos.memberState.get(projectKey, m.handle);
        if (state && state.status !== 'retired') continue;
        this.writeState(projectKey, m.handle, 'idle', null, null);
      }
      for (const m of previous?.team.members ?? []) {
        if (m.kind !== 'ai' || nextHandles.has(m.handle)) continue;
        this.writeState(projectKey, m.handle, 'retired', null, null);
      }
    });
    const previousMembers = new Map((previous?.team.members ?? []).map((m) => [m.handle, m]));
    const previousBlockers = new Map(
      (previous ? this.rosterFor(previous) : []).map((view) => [view.handle, view.aiApproverBlocker]),
    );
    for (const member of this.rosterFor(next)) {
      const configMember = memberOf(next, member.handle);
      // The AI approver blocker depends on other members and on the delegation settings.
      const blockerChanged = previousBlockers.has(member.handle)
        ? previousBlockers.get(member.handle) !== member.aiApproverBlocker
        : false;
      if (
        blockerChanged ||
        JSON.stringify(previousMembers.get(member.handle)) !== JSON.stringify(configMember)
      ) {
        this.ctx.bus.publish({ type: 'member_changed', projectKey, handle: member.handle, member });
      }
    }
    for (const handle of previousMembers.keys()) {
      if (!nextHandles.has(handle))
        this.ctx.bus.publish({ type: 'member_changed', projectKey, handle, member: null });
    }
    // A renamed member is the same in both configurations the listeners see, so the clients are told here:
    // the old handle is gone and the new one is the member (PM-1025).
    for (const [from, to] of Object.entries(change.renames ?? {})) {
      this.ctx.bus.publish({ type: 'member_changed', projectKey, handle: from, member: null });
      const member = this.rosterFor(next).find((view) => view.handle === to) ?? null;
      this.ctx.bus.publish({ type: 'member_changed', projectKey, handle: to, member });
    }
  }

  /** Stores an AI member's runtime status and tells the clients. */
  private writeState(
    projectKey: string,
    handle: string,
    status: MemberStatus,
    activity: string | null,
    activityTaskKey: TaskKey | null,
  ): void {
    this.ctx.repos.memberState.upsert({
      projectKey,
      handle,
      status,
      activity,
      activityTaskKey,
      updatedAt: isoNow(this.ctx),
    });
    this.ctx.bus.publish({ type: 'member_state', projectKey, handle, status, activity, activityTaskKey });
  }

  /** Websocket presence changed: publish the human member's online/offline status. */
  async presenceChanged(email: string): Promise<void> {
    const status: MemberStatus = this.presence.isOnline(email) ? 'online' : 'offline';
    for (const project of this.projects.summaries()) {
      const config = await this.projects.config(project.key).catch(() => null);
      const member = config ? findHumanByEmail(config, email) : undefined;
      if (member) {
        this.ctx.bus.publish({
          type: 'member_state',
          projectKey: project.key,
          handle: member.handle,
          status,
          activity: null,
          activityTaskKey: null,
        });
      }
    }
  }
}

/**
 * A member's profile page: the roster entry, duties, open work (assigned, in a session, waiting
 * for their approval or answer), inbox, timeline and sessions, as the viewer may see them.
 * Separate from MemberService because it reads the sessions and the admission's load, which
 * are built after the roster.
 */
export class MemberProfiles {
  private readonly ctx: DomainContext;
  private readonly projects: ProjectService;
  private readonly members: MemberService;
  private readonly tasks: TaskService;
  private readonly inbox: InboxService;
  private readonly sessions: MemberProfileSessions;
  private readonly admission: MemberCapacity;

  constructor(deps: {
    ctx: DomainContext;
    projects: ProjectService;
    members: MemberService;
    tasks: TaskService;
    inbox: InboxService;
    sessions: MemberProfileSessions;
    admission: MemberCapacity;
  }) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.members = deps.members;
    this.tasks = deps.tasks;
    this.inbox = deps.inbox;
    this.sessions = deps.sessions;
    this.admission = deps.admission;
  }

  /** What an AI member's sessions used in the last day and week (PM-178), by the hour. */
  private recentUsage(projectKey: string, handle: string): MemberUsage {
    const now = this.ctx.now().getTime();
    const since = (hours: number) => new Date(now - hours * 3_600_000);
    return {
      lastDay: this.ctx.repos.tokenUsage.forMember(projectKey, handle, since(24)),
      lastWeek: this.ctx.repos.tokenUsage.forMember(projectKey, handle, since(24 * 7)),
    };
  }

  async profile(projectKey: string, handle: string, viewer: Viewer): Promise<MemberProfile> {
    const config = await this.projects.config(projectKey);
    const original = memberOf(config, handle);
    const member = this.members.rosterFor(config).find((m) => m.handle === handle);
    if (!original || !member) throw notFound('member', handle);
    const approverStages = new Set(
      config.pipeline.stages.filter((s) => stageApprovers(config, s).includes(handle)).map((s) => s.id),
    );
    const openInbox = this.inbox
      .list(projectKey, { state: 'open' })
      .filter((i) => i.assignees.includes(handle));
    const awaitingKeys = new Set(openInbox.map((i) => i.taskKey));
    const capacityHolders = original.kind === 'ai' ? this.admission.holders(config, handle) : undefined;
    return {
      member,
      duties: memberDuties(config, original),
      tasks: this.tasks
        .listQuery(projectKey, { kind: 'open' })
        .filter(
          (t) =>
            !isTheme(t) &&
            (t.assignee === handle ||
              member.currentTaskKeys.includes(t.key) ||
              approverStages.has(t.stageId) ||
              awaitingKeys.has(t.key)),
        ),
      inbox: openInbox,
      timeline: this.ctx.repos.timeline
        .forMember(projectKey, handle)
        .map((event) => visibleTimelineEvent(viewer, event, (id) => this.ctx.repos.messages.get(id))),
      // The Operator's sessions and the PM's conversations with others are the owner's and the admin's to see
      // (PM-475, PM-1080).
      sessions: this.sessions
        .list(projectKey, { member: handle })
        .filter((session) => canSeeOperatorSessions(viewer) || !this.sessions.isRestrictedSession(session.id))
        .map((session) => visibleSession(viewer, session, (id) => this.ctx.repos.messages.get(id)))
        .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)),
      capacity: original.kind === 'ai' ? original.capacity : null,
      capacityUsed: capacityHolders ? capacityHolders.length : 0,
      ...(capacityHolders ? { capacityHolders } : {}),
      ...(original.kind === 'ai' ? { usage: this.recentUsage(projectKey, handle) } : {}),
      ...(original.kind === 'human' && ['owner', 'admin'].includes(viewer.access) && original.email
        ? { email: original.email }
        : {}),
    };
  }
}
