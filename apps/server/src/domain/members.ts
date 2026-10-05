import {
  AiMemberConfig,
  HumanMemberConfig,
  DEFAULT_AGENT_PROVIDER,
  modelForProvider,
  holdersAllow,
  MemberHandle,
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
} from '@projectman/shared';
import type {
  Actor,
  AddHumanMemberRequest,
  HireMemberRequest,
  MemberProfile,
  MemberStatus,
  MemberUsage,
  MemberView,
  ProjectConfig,
  SessionState,
  UpdateMemberRequest,
} from '@projectman/shared';
import { aiMemberDefaults } from '@projectman/templates';
import { findHumanByEmail, ownerHandles, requireAiMember, requireHuman } from './access';
import type { ProjectAccess } from './access';
import { isoNow } from './context';
import type { DomainContext } from './context';
import { conflict, DomainError, invalid, notFound } from './errors';
import type { InboxService } from './inbox';
import { defaultMemberHandle, defaultMemberName, humanMemberHandle } from './naming';
import type { PresenceService } from './presence';
import type { Admission } from './admission';
import type { Author, ConfigChange, ProjectService } from './projects';
import type { SessionOrchestrator } from './sessions';
import { isOpenTask, isTheme } from './tasks';
import type { TaskService } from './tasks';
import type { TimelineService } from './timeline';
import { unique } from './util';
import { canSeeTask, isClient, memberForViewer, visibleTasks as visibleTasksOf } from './visibility';
import type { Viewer } from './visibility';

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

  constructor(deps: {
    ctx: DomainContext;
    projects: ProjectService;
    timeline: TimelineService;
    presence: PresenceService;
    inbox: InboxService;
  }) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.timeline = deps.timeline;
    this.presence = deps.presence;
    this.inbox = deps.inbox;
  }

  async roster(projectKey: string): Promise<MemberView[]> {
    return this.rosterFor(await this.projects.config(projectKey));
  }

  /** The roster as the viewer sees it: a client gets no key of a card they cannot see. */
  async rosterOf(projectKey: string, viewer: Viewer): Promise<MemberView[]> {
    return this.rosterForViewer(await this.projects.config(projectKey), viewer);
  }

  rosterForViewer(config: ProjectConfig, viewer: Viewer): MemberView[] {
    const tasks = new Map(this.ctx.repos.tasks.list(config.project.key).map((t) => [t.key, t]));
    const canSeeKey = (key: string) => {
      const task = tasks.get(key);
      return !!task && canSeeTask(viewer, task);
    };
    return this.rosterFor(config).map((member) => memberForViewer(viewer, member, canSeeKey));
  }

  /** Every member's whole state, for the team's own use (AI members, hand-overs); never send it to a viewer. */
  rosterFor(config: ProjectConfig): MemberView[] {
    const projectKey = config.project.key;
    const openTasks = new Map(
      this.ctx.repos.tasks
        .list(projectKey)
        // A theme is carried by nobody and never counts as work (PM-192).
        .filter((t) => isOpenTask(t) && !isTheme(t))
        .map((t) => [t.key, t]),
    );
    const sessions = this.ctx.repos.sessions.list(projectKey);
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
          currentTaskKeys,
          sponsor: null,
          temp: false,
        };
      }
      const state = states.get(m.handle);
      return {
        handle: m.handle,
        displayName: m.displayName,
        githubLogin: m.githubLogin,
        kind: 'ai',
        role: m.role,
        roles: memberRoles(m),
        specialty: m.specialty ?? null,
        status: state && state.status !== 'retired' ? state.status : 'idle',
        activity: state?.activity ?? null,
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
        ...(m.onLeave ? { onLeave: true } : {}),
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
    const taken = new Set(config.team.members.map((m) => m.handle));
    for (const s of this.ctx.repos.memberState.list(projectKey)) taken.add(s.handle);
    for (const s of this.ctx.repos.sessions.list(projectKey)) taken.add(s.member);
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
      assertRoleFor(draft, req.role, 'ai');
      const defaults = aiMemberDefaults(req.role, draft.team.roles, draft.team.roleOverrides);
      if (!defaults) throw invalid('role_not_for_ai', `no AI member can hold the role ${req.role}`);
      const sponsor = memberOf(draft, by.sponsor);
      if (!sponsor || sponsor.kind !== 'human') {
        throw invalid('invalid_sponsor', `sponsor must be a human member: ${by.sponsor}`);
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
          req.provider === 'codex' || req.provider === 'nanogpt'
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
      });
      draft.team.members.push(member);
      if (opts.temp && opts.stageId) {
        const stage = stageOf(draft, opts.stageId);
        if (stage?.owners) stage.owners = [...stage.owners, handle];
      } else if (!opts.temp) {
        for (const stage of stagesToJoin(draft, member)) stage.owners = [...(stage.owners ?? []), handle];
      }
      hired = member;
      return opts.temp ? `Hire temporary ${req.role} ${handle}` : `Hire ${req.role} ${handle}`;
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

  /**
   * Changes a member (a configuration commit): the display name of anyone, the roles a human
   * holds, and an AI member's specialty, provider, model, effort, compaction window, cheap subagent, schedule and own instructions. An AI member's one role stays.
   */
  async update(
    projectKey: string,
    handle: string,
    req: UpdateMemberRequest,
    by: { actor: Actor; author: Author },
  ): Promise<MemberView> {
    await this.projects.update(projectKey, by, (draft) => {
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
          req.model !== undefined ||
          req.schedule !== undefined ||
          req.provider !== undefined ||
          req.effort !== undefined ||
          req.autoCompactWindowTokens !== undefined ||
          req.cheapSubagent !== undefined ||
          req.onLeave !== undefined ||
          req.instructions !== undefined ||
          req.permissionMode !== undefined ||
          req.approver !== undefined
        ) {
          throw invalid(
            'not_ai_member',
            'specialty, provider, model, effort, compaction window, cheap subagent, schedule, leave, instructions, permission mode and approver apply to AI members only',
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
          member.model = modelForProvider(req.provider, member.model);
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
        if (req.onLeave !== undefined) {
          if (req.onLeave) member.onLeave = true;
          else delete member.onLeave;
          fields.push(req.onLeave ? 'sent on leave' : 'called back from leave');
        }
      }
      if (req.displayName !== undefined) {
        member.displayName = req.displayName;
        fields.push('display name');
      }
      return `Update ${handle}${fields.length > 0 ? `: ${fields.join(', ')}` : ''}`;
    });
    const view = (await this.roster(projectKey)).find((m) => m.handle === handle);
    if (!view) throw notFound('member', handle);
    return view;
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
    const handoverTo = opts.handoverTo ?? null;
    if (handoverTo !== null) {
      if (handoverTo === handle) throw invalid('invalid_request', 'cannot hand over to the retiring member');
      if (!memberOf(config, handoverTo)) throw notFound('member', handoverTo);
    }

    const handovers = handoverTo ? { [handle]: handoverTo } : undefined;
    await this.projects.update(projectKey, { ...by, handovers }, (draft) => {
      if (!memberOf(draft, handle)) throw notFound('member', handle);
      draft.team.members = draft.team.members.filter((m) => m.handle !== handle);
      for (const stage of draft.pipeline.stages) {
        if (!(stage.owners ?? []).includes(handle)) continue;
        stage.owners = unique(
          (stage.owners ?? []).flatMap((h) => (h === handle ? (handoverTo ? [handoverTo] : []) : [h])),
        );
      }
      return `Retire ${handle}${handoverTo ? ` (handover to ${handoverTo})` : ''}`;
    });
    for (const item of this.inbox.cancelOpenFromSource(projectKey, handle))
      await this.ctx.events.emit('inbox_cancelled', item);

    this.timeline.append({
      projectKey,
      actor: by.actor,
      type: 'member_retired',
      data: { handle, handoverTo },
    });
  }

  async removeHuman(projectKey: string, handle: string, by: { actor: Actor; author: Author }): Promise<void> {
    await this.projects.update(projectKey, by, (draft) => {
      const member = memberOf(draft, handle);
      if (!member) throw notFound('member', handle);
      if (member.kind !== 'human') throw invalid('not_human_member', 'Only humans can be removed');
      draft.team.members = draft.team.members.filter((m) => m.handle !== handle);
      // Sponsors and explicit gate approvers must be reassigned before removal.
      for (const stage of draft.pipeline.stages) {
        if (stage.owners) stage.owners = stage.owners.filter((h) => h !== handle);
      }
      return `Remove human member ${handle}`;
    });
    this.inbox.reassignRemovedHuman(projectKey, handle, ownerHandles(await this.projects.config(projectKey)));
  }

  /** Records an AI member's runtime status; retired members stay retired. */
  setState(projectKey: string, handle: string, status: MemberStatus, activity: string | null): void {
    const current = this.ctx.repos.memberState.get(projectKey, handle);
    if (current?.status === 'retired') return;
    if (current && current.status === status && current.activity === activity) return;
    this.writeState(projectKey, handle, status, activity);
  }

  /** Startup: no session survived the restart, so no AI member is working or waiting. */
  reconcileAfterRestart(): void {
    for (const project of this.ctx.repos.projects.list()) {
      for (const state of this.ctx.repos.memberState.list(project.key)) {
        this.setState(project.key, state.handle, 'idle', null);
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
        this.writeState(projectKey, m.handle, 'idle', null);
      }
      for (const m of previous?.team.members ?? []) {
        if (m.kind !== 'ai' || nextHandles.has(m.handle)) continue;
        this.writeState(projectKey, m.handle, 'retired', null);
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
  }

  /** Stores an AI member's runtime status and tells the clients. */
  private writeState(
    projectKey: string,
    handle: string,
    status: MemberStatus,
    activity: string | null,
  ): void {
    this.ctx.repos.memberState.upsert({ projectKey, handle, status, activity, updatedAt: isoNow(this.ctx) });
    this.ctx.bus.publish({ type: 'member_state', projectKey, handle, status, activity });
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
  private readonly sessions: Pick<SessionOrchestrator, 'list'>;
  private readonly admission: Pick<Admission, 'memberLoad'>;

  constructor(deps: {
    ctx: DomainContext;
    projects: ProjectService;
    members: MemberService;
    tasks: TaskService;
    inbox: InboxService;
    sessions: Pick<SessionOrchestrator, 'list'>;
    admission: Pick<Admission, 'memberLoad'>;
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
    const member = this.members.rosterForViewer(config, viewer).find((m) => m.handle === handle);
    if (!original || !member) throw notFound('member', handle);
    const internal = !isClient(viewer);
    const approverStages = new Set(
      config.pipeline.stages.filter((s) => stageApprovers(config, s).includes(handle)).map((s) => s.id),
    );
    const openInbox = this.inbox
      .list(projectKey)
      .filter((i) => i.state === 'open' && i.assignees.includes(handle));
    const awaitingKeys = new Set(openInbox.map((i) => i.taskKey));
    const visibleTasks = visibleTasksOf(viewer, this.tasks.list(projectKey));
    return {
      member,
      duties: memberDuties(config, original),
      tasks: visibleTasks.filter(
        (t) =>
          isOpenTask(t) &&
          !isTheme(t) &&
          (t.assignee === handle ||
            member.currentTaskKeys.includes(t.key) ||
            approverStages.has(t.stageId) ||
            awaitingKeys.has(t.key)),
      ),
      // A client sees only their own open inbox.
      inbox: internal || handle === viewer.handle ? openInbox : [],
      timeline: internal ? this.ctx.repos.timeline.forMember(projectKey, handle) : [],
      sessions: internal
        ? this.sessions
            .list(projectKey, { member: handle })
            .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
        : [],
      capacity: original.kind === 'ai' ? original.capacity : null,
      capacityUsed: original.kind === 'ai' && internal ? this.admission.memberLoad(config, handle) : 0,
      ...(original.kind === 'ai' && internal ? { usage: this.recentUsage(projectKey, handle) } : {}),
      ...(original.kind === 'human' && ['owner', 'admin'].includes(viewer.access) && original.email
        ? { email: original.email }
        : {}),
    };
  }
}
