import { cronMatches, nextCronRun, ScheduleSkipReason } from '@projectman/shared';
import type { ScheduleRun, SchedulesView } from '@projectman/shared';
import type { DomainContext } from './context';
import { conflict, DomainError, invalid, notFound, unavailable } from './errors';
import type { ProjectService } from './projects';
import type { Scheduler } from './scheduler';
import type { SessionOrchestrator } from './sessions';
import type { TimelineService } from './timeline';
import { excerpt, newId, SYSTEM_ACTOR } from './util';

export interface ScheduleTimer {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}
const defaultTimer: ScheduleTimer = {
  set(callback, delay) {
    const timer = setTimeout(callback, delay);
    timer.unref();
    return timer;
  },
  clear(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

/** One current-minute attempt per member; missed minutes are never replayed. */
export class ScheduleService {
  private timerHandle: unknown;
  private active = false;
  private pending: Promise<void> = Promise.resolve();
  private readonly unsubscribe: () => void;
  private readonly timer: ScheduleTimer;
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(privateDeps: {
    ctx: DomainContext;
    projects: ProjectService;
    scheduler: Scheduler;
    sessions: SessionOrchestrator;
    timeline: TimelineService;
    timer?: ScheduleTimer;
  }) {
    this.deps = privateDeps;
    this.timer = privateDeps.timer ?? defaultTimer;
    this.unsubscribe = privateDeps.ctx.bus.subscribe((event) => {
      if (event.type !== 'session_upserted' || event.session.workItem.type !== 'schedule') return;
      const session = event.session;
      if (session.state !== 'exited' && session.state !== 'failed') return;
      const run = this.deps.ctx.repos.schedules.get(event.session.workItem.runId);
      if (!run || run.status !== 'started') return;
      this.deps.ctx.repos.schedules.update(run.id, {
        ...run,
        sessionId: session.id,
        status: session.state === 'failed' ? 'failed' : 'done',
        reason: session.state === 'failed' ? (session.activity ?? 'session_failed') : null,
      });
    });
  }
  private readonly deps;

  start(): void {
    if (this.active) return;
    // Processes cannot survive a restart. Close attempts left live by the previous server.
    for (const run of this.deps.ctx.repos.schedules.live()) {
      this.deps.ctx.repos.schedules.update(run.id, { ...run, status: 'failed', reason: 'server_restarted' });
    }
    this.active = true;
    this.queueCheck();
    this.arm();
  }

  stop(): Promise<void> {
    this.active = false;
    this.timer.clear(this.timerHandle);
    this.unsubscribe();
    return Promise.allSettled([this.pending, ...this.inFlight]).then(() => undefined);
  }

  private arm(): void {
    this.timerHandle = this.timer.set(
      () => {
        if (!this.active) return;
        this.queueCheck();
        this.arm();
      },
      60_000 - (this.deps.ctx.now().getTime() % 60_000),
    );
  }

  private queueCheck(): void {
    // Capture the observed minute, and discard queued stale ticks rather than backfill.
    const minute = Math.floor(this.deps.ctx.now().getTime() / 60_000);
    this.pending = this.pending
      .then(async () => {
        if (!this.active || Math.floor(this.deps.ctx.now().getTime() / 60_000) !== minute) return;
        await this.check();
      })
      .catch((err: unknown) => this.deps.ctx.logger.warn({ err }, 'schedule check failed'));
  }

  /** Also exposed for deterministic clock-driven tests. */
  async check(): Promise<void> {
    const at = new Date(Math.floor(this.deps.ctx.now().getTime() / 60_000) * 60_000);
    for (const project of this.deps.projects.summaries()) {
      try {
        const config = await this.deps.projects.config(project.key);
        for (const member of config.team.members) {
          if (member.kind !== 'ai' || !member.schedule) continue;
          try {
            if (cronMatches(member.schedule.cron, at, config.project.timezone)) {
              await this.run(project.key, member.handle, at.toISOString(), true);
            }
          } catch (err) {
            this.deps.ctx.logger.warn(
              { err, projectKey: project.key, member: member.handle },
              'could not check member schedule',
            );
          }
        }
      } catch (err) {
        this.deps.ctx.logger.warn({ err, projectKey: project.key }, 'could not check member schedules');
      }
    }
  }

  async view(projectKey: string): Promise<SchedulesView> {
    const config = await this.deps.projects.config(projectKey);
    const timezone = config.project.timezone;
    return {
      timezone,
      members: config.team.members.flatMap((member) => {
        if (member.kind !== 'ai' || !member.schedule) return [];
        let nextRun: string | null = null;
        try {
          nextRun = nextCronRun(member.schedule.cron, this.deps.ctx.now(), timezone);
        } catch {
          /* Legacy invalid schedules have no next run. */
        }
        return [
          {
            member: member.handle,
            cron: member.schedule.cron,
            promptSummary: excerpt(member.schedule.prompt),
            nextRun,
          },
        ];
      }),
      runs: this.deps.ctx.repos.schedules.list(projectKey),
    };
  }

  async runNow(projectKey: string, handle: string): Promise<ScheduleRun> {
    const run = await this.run(projectKey, handle, this.deps.ctx.now().toISOString(), false);
    if (!run) throw unavailable('server_stopping', 'Schedule service is stopping');
    return run;
  }

  private run(
    projectKey: string,
    handle: string,
    scheduledFor: string,
    automatic: boolean,
  ): Promise<ScheduleRun | null> {
    // Shares admission with task starts, including asynchronous usage/login checks.
    const execution = this.deps.scheduler.admit(async () => {
      if (
        !this.active ||
        (automatic &&
          Math.floor(this.deps.ctx.now().getTime() / 60_000) !==
            Math.floor(new Date(scheduledFor).getTime() / 60_000))
      )
        return null;
      const { ctx, projects, sessions, scheduler, timeline } = this.deps;
      const previous = automatic ? ctx.repos.schedules.occurrence(projectKey, handle, scheduledFor) : null;
      if (previous) return previous;
      const config = await projects.config(projectKey);
      const member = config.team.members.find((m) => m.handle === handle);
      if (!member) throw notFound('member', handle);
      if (member.kind !== 'ai' || !member.schedule)
        throw invalid('member_not_scheduled', 'Member has no AI schedule');
      const run: ScheduleRun = {
        id: newId('run'),
        projectKey,
        member: handle,
        scheduledFor,
        startedAt: null,
        sessionId: null,
        status: 'started',
        reason: null,
      };
      ctx.repos.schedules.insert(run, automatic);
      try {
        if (!config.team.limits.aiEnabled) await scheduler.assertCanStartAiWork(config, member.provider);
        if (
          sessions
            .list(projectKey, { member: handle })
            .some((s) => s.workItem.type === 'schedule' && sessions.isRunning(s.id))
        )
          throw conflict('previous_run_live', 'Previous scheduled run is still live');
        if (scheduler.memberLoad(projectKey, handle) >= member.capacity)
          throw conflict('member_at_capacity', 'Member is at capacity');
        await scheduler.assertCanStartAiWork(config, member.provider);
        const { session } = await sessions.ensureSession(projectKey, handle, {
          type: 'schedule',
          runId: run.id,
        });
        const current = ctx.repos.schedules.get(run.id)!;
        const updated = ctx.repos.schedules.update(run.id, {
          ...current,
          startedAt: session.startedAt,
          sessionId: session.id,
        });
        timeline.append({
          projectKey,
          taskKey: null,
          sessionId: session.id,
          actor: SYSTEM_ACTOR,
          type: 'schedule_started',
          data: { runId: run.id, member: handle, scheduledFor },
        });
        return updated;
      } catch (err) {
        const code = err instanceof DomainError ? err.code : 'session_start_failed';
        const skipped = ScheduleSkipReason.safeParse(code).success;
        const session = ctx.repos.sessions.findByWorkItem(projectKey, handle, {
          type: 'schedule',
          runId: run.id,
        });
        const updated = ctx.repos.schedules.update(run.id, {
          ...run,
          status: skipped ? 'skipped' : 'failed',
          reason: code,
          sessionId: session?.id ?? null,
          startedAt: session?.startedAt ?? null,
        });
        if (skipped)
          timeline.append({
            projectKey,
            taskKey: null,
            sessionId: updated.sessionId,
            actor: SYSTEM_ACTOR,
            type: 'schedule_skipped',
            data: { runId: run.id, member: handle, scheduledFor, reason: code },
          });
        return updated;
      }
    });
    this.inFlight.add(execution);
    void execution.then(
      () => this.inFlight.delete(execution),
      () => this.inFlight.delete(execution),
    );
    return execution;
  }
}
