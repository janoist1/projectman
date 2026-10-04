import {
  DEFAULT_PAUSE_FORCE_AFTER_MS,
  canManageInstancePause,
  isWorkPaused,
  pauseStateOf,
} from '@projectman/shared';
import type {
  InstancePauseView,
  PausePoint,
  PauseKind,
  PauseScopeKind,
  PauseSource,
  PauseStatus,
  PausedSession,
  ProjectPauseView,
  ServerEvent,
  Session,
  Task,
  TimelineEventType,
} from '@projectman/shared';
import { mockId, nowIso } from './time';

/** What the pause needs of the fake backend (the backend implements it). */
export interface PauseHost {
  projectKey: string;
  sessions(): Session[];
  tasks(): Task[];
  /** The viewer's display name, handle and role in the project (the fake has one project). */
  viewer(): { name: string; handle: string; role: string };
  isLive(session: Session): boolean;
  isAiMember(handle: string): boolean;
  emit(event: ServerEvent): void;
  addTimeline(
    taskKey: string | null,
    who: string | null,
    type: TimelineEventType,
    data: Record<string, unknown>,
  ): void;
  updateSession(id: string, patch: Partial<Session>): Session | undefined;
  updateTask(key: string, patch: Partial<Task>): Task | undefined;
  /** The live AI sessions that have an idle chat, to be flushed once the team works again. */
  flushHeldMessages(): void;
}

interface OpenPause extends Omit<PauseStatus, 'state' | 'sessions'> {
  rows: PausedSession[];
}

export interface PauseInstanceOptions {
  kind?: PauseKind;
  source?: PauseSource;
  reason?: string | null;
  requestedBy?: string | null;
}

/** Where a session that is not in a turn stops at once, by its state. */
const IMMEDIATE_POINT: Partial<Record<Session['state'], PausePoint>> = {
  idle: 'idle',
  waiting_permission: 'waiting_permission',
  waiting_input: 'waiting_input',
};

/**
 * The fake's pauses (PM-220): the same views, events and rules as the server's, with the shared
 * `isWorkPaused` and `pauseStateOf` deciding. A test settles the running sessions with `settle`.
 */
export class MockPauses {
  private open: OpenPause[] = [];
  private readonly host: PauseHost;

  constructor(host: PauseHost) {
    this.host = host;
  }

  /** The work of the project is held. */
  isPaused(): boolean {
    return isWorkPaused(this.open, this.host.projectKey);
  }

  private statusOf(pause: OpenPause): PauseStatus {
    const { rows, ...rest } = pause;
    return {
      ...rest,
      state: pauseStateOf(rows),
      sessions: JSON.parse(JSON.stringify(rows)) as PausedSession[],
    };
  }

  private find(scope: PauseScopeKind): OpenPause | undefined {
    return this.open.find((pause) => pause.scope === scope);
  }

  projectView(): ProjectPauseView {
    const project = this.find('project');
    const instance = this.find('instance');
    return {
      project: project ? this.statusOf(project) : null,
      instance: instance ? this.statusOf(instance) : null,
    };
  }

  instanceView(): InstancePauseView {
    const instance = this.find('instance');
    return {
      pause: instance ? this.statusOf(instance) : null,
      // The fake has one project: its owner is an owner in every project.
      canManage: canManageInstancePause([this.host.viewer().role === 'owner' ? 'owner' : null]),
    };
  }

  /** The viewer may pause a project: an owner or an admin. */
  mayManageProject(): boolean {
    return ['owner', 'admin'].includes(this.host.viewer().role);
  }

  private publish(): void {
    this.host.emit({ type: 'pause_changed', projectKey: this.host.projectKey, pause: this.projectView() });
  }

  private hold(pause: OpenPause): void {
    for (const session of this.host.sessions()) {
      if (!this.host.isLive(session) || !this.host.isAiMember(session.member)) continue;
      if (this.open.some((entry) => entry.rows.some((row) => row.sessionId === session.id))) continue;
      const point = IMMEDIATE_POINT[session.state] ?? null;
      const at = nowIso();
      const row: PausedSession = {
        sessionId: session.id,
        projectKey: session.projectKey,
        member: session.member,
        workItem: session.workItem,
        since: at,
        point,
        tool: null,
        waitingFor: point ? null : 'Bash',
        pausedAt: point ? at : null,
        stopped: false,
      };
      pause.rows.push(row);
      this.host.updateSession(session.id, { pause: { since: at, point, tool: null } });
    }
  }

  /** A person's request, the Szünet button. An open pause of the same scope stays as it is. */
  pauseProject(): ProjectPauseView {
    if (!this.find('project')) {
      const pause = this.create('project', {
        kind: 'manual',
        source: 'app',
        reason: null,
        requestedBy: this.host.viewer().name,
      });
      this.host.addTimeline(null, this.host.viewer().handle, 'team_paused', {
        pauseId: pause.id,
        scope: 'project',
        source: 'app',
        reason: null,
        forceAfterMs: DEFAULT_PAUSE_FORCE_AFTER_MS,
      });
      this.publish();
    }
    return this.projectView();
  }

  /** The instance's pause, asked by the control command or the system (no person behind it). */
  pauseInstance(options: PauseInstanceOptions = {}): void {
    if (this.find('instance')) return;
    const kind = options.kind ?? 'manual';
    const source = options.source ?? 'control';
    const pause = this.create('instance', {
      kind,
      source,
      reason: options.reason ?? null,
      requestedBy: options.requestedBy ?? null,
    });
    // Like the server: a pause made for the shutdown writes no event.
    if (kind === 'manual')
      this.host.addTimeline(null, null, 'team_paused', {
        pauseId: pause.id,
        scope: 'instance',
        source,
        reason: pause.reason,
        forceAfterMs: DEFAULT_PAUSE_FORCE_AFTER_MS,
      });
    this.publish();
  }

  private create(
    scope: PauseScopeKind,
    by: { kind: PauseKind; source: PauseSource; reason: string | null; requestedBy: string | null },
  ): OpenPause {
    const requestedAt = nowIso();
    const pause: OpenPause = {
      id: mockId('pau'),
      scope,
      projectKey: scope === 'project' ? this.host.projectKey : null,
      kind: by.kind,
      source: by.source,
      requestedBy: by.requestedBy,
      requestedAt,
      reason: by.reason,
      forceAt: new Date(Date.parse(requestedAt) + DEFAULT_PAUSE_FORCE_AFTER_MS).toISOString(),
      rows: [],
    };
    this.open.push(pause);
    this.hold(pause);
    return pause;
  }

  /** A test: the running session of the held sessions reached a safe point. */
  settle(sessionId: string, point: PausePoint, tool: string | null = null): void {
    const pause = this.open.find((entry) => entry.rows.some((row) => row.sessionId === sessionId));
    const row = pause?.rows.find((entry) => entry.sessionId === sessionId);
    if (!pause || !row) return;
    const at = nowIso();
    Object.assign(row, { point, tool, waitingFor: null, pausedAt: at });
    this.host.updateSession(sessionId, { pause: { since: row.since, point, tool } });
    this.publish();
  }

  /** The viewer's "Megállítás most": every session that still runs is cut where it is. */
  force(scope: PauseScopeKind): void {
    const pause = this.find(scope);
    if (!pause) return;
    pause.forceAt = nowIso();
    for (const row of pause.rows) {
      if (row.point !== null) continue;
      this.settle(row.sessionId, 'interrupted', row.waitingFor);
    }
    this.publish();
  }

  resume(scope: PauseScopeKind, by: string | null = this.host.viewer().handle): void {
    const pause = this.find(scope);
    if (!pause) return;
    this.open = this.open.filter((entry) => entry !== pause);
    for (const row of pause.rows) {
      const stillHeld = this.open.some((entry) => entry.rows.some((r) => r.sessionId === row.sessionId));
      if (!stillHeld) this.host.updateSession(row.sessionId, { pause: undefined });
    }
    if (pause.kind === 'manual')
      this.host.addTimeline(null, by, 'team_resumed', {
        pauseId: pause.id,
        scope: pause.scope,
        source: pause.source,
      });
    // A start that waited for the pause goes on once nothing holds the project.
    if (!this.isPaused())
      for (const task of this.host.tasks())
        if (task.startWaiting?.reason === 'team_paused')
          this.host.updateTask(task.key, { startWaiting: undefined });
    this.publish();
    if (!this.isPaused()) this.host.flushHeldMessages();
  }
}
