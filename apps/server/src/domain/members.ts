import { AiMemberConfig, holdersAllow, MemberHandle, roleHolders } from '@projectman/shared';
import type {
  Actor,
  HireMemberRequest,
  MemberStatus,
  MemberView,
  ProjectConfig,
  SessionState,
} from '@projectman/shared';
import { aiMemberDefaults } from '@projectman/templates';
import { findHumanByEmail } from './access';
import { isoNow } from './context';
import type { DomainContext } from './context';
import { conflict, invalid, notFound } from './errors';
import type { InboxService } from './inbox';
import { defaultMemberHandle, defaultMemberName } from './naming';
import type { PresenceService } from './presence';
import type { Author, ConfigChange, ProjectService } from './projects';
import { isOpenTask } from './tasks';
import type { TaskService } from './tasks';
import type { TimelineService } from './timeline';
import { unique } from './util';

const ENDED_SESSION_STATES = new Set<SessionState>(['exited', 'failed']);

/** Throws unless a member of this kind may hold the role (a built-in or one of the team's custom roles). */
export function assertRoleFor(config: ProjectConfig, role: string, kind: 'human' | 'ai'): void {
  const holders = roleHolders(role, config.team.roles);
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
  private readonly tasks: TaskService;
  private readonly inbox: InboxService;

  constructor(deps: {
    ctx: DomainContext;
    projects: ProjectService;
    timeline: TimelineService;
    presence: PresenceService;
    tasks: TaskService;
    inbox: InboxService;
  }) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.timeline = deps.timeline;
    this.presence = deps.presence;
    this.tasks = deps.tasks;
    this.inbox = deps.inbox;
  }

  async roster(projectKey: string): Promise<MemberView[]> {
    return this.rosterFor(await this.projects.config(projectKey));
  }

  rosterFor(config: ProjectConfig): MemberView[] {
    const projectKey = config.project.key;
    const openTasks = new Map(
      this.ctx.repos.tasks
        .list(projectKey)
        .filter(isOpenTask)
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
      const currentTaskKeys = [...keys].sort((a, b) => taskNumber(a) - taskNumber(b));
      if (m.kind === 'human') {
        return {
          handle: m.handle,
          displayName: m.displayName,
          kind: 'human',
          role: m.access,
          roles: m.roles,
          specialty: null,
          status: this.presence.isOnline(m.email) ? 'online' : 'offline',
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
        kind: 'ai',
        role: m.role,
        roles: [m.role],
        specialty: m.specialty ?? null,
        status: state && state.status !== 'retired' ? state.status : 'idle',
        activity: state?.activity ?? null,
        currentTaskKeys,
        sponsor: m.sponsor,
        temp: m.temp,
      };
    });
  }

  /** Handles in use now or in the past (config, runtime state incl. retired, sessions). */
  takenHandles(projectKey: string, config: ProjectConfig): Set<string> {
    const taken = new Set(config.team.members.map((m) => m.handle));
    for (const s of this.ctx.repos.memberState.list(projectKey)) taken.add(s.handle);
    for (const s of this.ctx.repos.sessions.list(projectKey)) taken.add(s.member);
    return taken;
  }

  /**
   * Hires an AI member for any role an AI may hold (built-in or custom) with the role's
   * defaults; `sponsor` is the human whose subscription runs it.
   */
  async hire(
    projectKey: string,
    req: HireMemberRequest,
    by: { actor: Actor; author: Author; sponsor: string },
    opts: { temp?: boolean } = {},
  ): Promise<AiMemberConfig> {
    let hired: AiMemberConfig | null = null;
    await this.projects.update(projectKey, { actor: by.actor, author: by.author }, (draft) => {
      assertRoleFor(draft, req.role, 'ai');
      const defaults = aiMemberDefaults(req.role, draft.team.roles);
      if (!defaults) throw invalid('role_not_for_ai', `no AI member can hold the role ${req.role}`);
      const sponsor = draft.team.members.find((m) => m.handle === by.sponsor);
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
        model: req.model ?? defaults.model,
        permissionMode: defaults.permissionMode,
        capacity: defaults.capacity,
        instructions: defaults.instructions,
        sponsor: sponsor.handle,
        temp: opts.temp ?? false,
        ...(req.schedule ? { schedule: req.schedule } : {}),
      });
      draft.team.members.push(member);
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
   * Retires an AI member: its open tasks go to `handoverTo` (or become unassigned), its stage
   * ownerships move to `handoverTo`, its sessions are stopped (config change listener).
   */
  async retire(
    projectKey: string,
    handle: string,
    opts: { handoverTo?: string },
    by: { actor: Actor; author: Author },
  ): Promise<void> {
    const config = await this.projects.config(projectKey);
    const member = config.team.members.find((m) => m.handle === handle);
    if (!member) throw notFound('member', handle);
    if (member.kind !== 'ai') throw invalid('not_ai_member', 'only AI members can be retired');
    const handoverTo = opts.handoverTo ?? null;
    if (handoverTo !== null) {
      if (handoverTo === handle) throw invalid('invalid_request', 'cannot hand over to the retiring member');
      if (!config.team.members.some((m) => m.handle === handoverTo)) throw notFound('member', handoverTo);
    }

    for (const task of this.ctx.repos.tasks.listByAssignee(projectKey, handle)) {
      if (isOpenTask(task))
        this.tasks.assign(projectKey, task.key, handoverTo, by.actor, { reason: 'handover', from: handle });
    }
    this.inbox.cancelOpenFromSource(projectKey, handle);

    await this.projects.update(projectKey, by, (draft) => {
      if (!draft.team.members.some((m) => m.handle === handle)) throw notFound('member', handle);
      draft.team.members = draft.team.members.filter((m) => m.handle !== handle);
      for (const stage of draft.pipeline.stages) {
        if (!stage.owners.includes(handle)) continue;
        stage.owners = unique(
          stage.owners.flatMap((h) => (h === handle ? (handoverTo ? [handoverTo] : []) : [h])),
        );
      }
      return `Retire ${handle}${handoverTo ? ` (handover to ${handoverTo})` : ''}`;
    });
    this.timeline.append({
      projectKey,
      actor: by.actor,
      type: 'member_retired',
      data: { handle, handoverTo },
    });
  }

  /** Records an AI member's runtime status; retired members stay retired. */
  setState(projectKey: string, handle: string, status: MemberStatus, activity: string | null): void {
    const current = this.ctx.repos.memberState.get(projectKey, handle);
    if (current?.status === 'retired') return;
    if (current && current.status === status && current.activity === activity) return;
    this.ctx.repos.memberState.upsert({ projectKey, handle, status, activity, updatedAt: isoNow(this.ctx) });
    this.ctx.bus.publish({ type: 'member_state', projectKey, handle, status, activity });
  }

  /** Config change listener: new AI members start idle, removed ones become retired. */
  reconcile(change: ConfigChange): void {
    const { projectKey, previous, next } = change;
    const nextHandles = new Set(next.team.members.map((m) => m.handle));
    const at = isoNow(this.ctx);
    for (const m of next.team.members) {
      if (m.kind !== 'ai') continue;
      const state = this.ctx.repos.memberState.get(projectKey, m.handle);
      if (state && state.status !== 'retired') continue;
      this.ctx.repos.memberState.upsert({
        projectKey,
        handle: m.handle,
        status: 'idle',
        activity: null,
        updatedAt: at,
      });
      this.ctx.bus.publish({
        type: 'member_state',
        projectKey,
        handle: m.handle,
        status: 'idle',
        activity: null,
      });
    }
    for (const m of previous?.team.members ?? []) {
      if (m.kind !== 'ai' || nextHandles.has(m.handle)) continue;
      this.ctx.repos.memberState.upsert({
        projectKey,
        handle: m.handle,
        status: 'retired',
        activity: null,
        updatedAt: at,
      });
      this.ctx.bus.publish({
        type: 'member_state',
        projectKey,
        handle: m.handle,
        status: 'retired',
        activity: null,
      });
    }
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

function taskNumber(key: string): number {
  return Number(key.slice(key.lastIndexOf('-') + 1));
}
