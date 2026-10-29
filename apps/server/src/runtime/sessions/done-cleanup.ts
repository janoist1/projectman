import type { EngineId, Session, SessionStop } from '@projectman/shared';
import type { EngineDirectory, SessionRunner } from '../../contracts';
import type { DomainContext } from '../../core/base';
import { engineIdOf } from './engines';
import { errorCode } from './launch';
import type { SessionTimers } from './session-timers';
import type { TurnFinishes } from './turn-finish';

/** Worktree removals that are refused on purpose (the worktree module's error codes). */
const KEPT_WORKTREE_CODES = new Set(['dirty', 'outside_root', 'not_a_worktree', 'main_worktree']);

interface DoneCleanupDeps {
  ctx: DomainContext;
  engines: Pick<EngineDirectory, 'get'>;
  runner: Pick<SessionRunner, 'stop'>;
  timers: Pick<SessionTimers, 'arm'>;
  turns: Pick<TurnFinishes, 'wait'>;
  /** Delay before a done task's sessions are stopped and its worktrees removed. */
  delayMs: number;
  isRunning: (sessionId: string) => boolean;
  /** Records why the session is stopped (`LiveSessions.stopReasons`). */
  noteStop: (sessionId: string, stop: SessionStop) => void;
  markEnded: (sessionId: string, stop: SessionStop) => void;
  /** Whether the session's directory is a member workspace, which outlives its tasks (PM-138). */
  inWorkspace: (session: Session) => boolean;
  /** Runs a job that the manager's shutdown does not wait for (`SessionLifecycle.run`). */
  background: <A>(job: () => Promise<A>) => Promise<A | undefined>;
}

/**
 * The cleanup of a done task: its sessions stop and its clean worktrees are removed, some time after
 * the move, so that an in-flight tool result still reaches the agent.
 */
export class DoneCleanup {
  private readonly deps: DoneCleanupDeps;
  /** The mover the pending cleanup of each task runs with: a task has one timer, however often it moved to done. */
  private readonly movers = new Map<string, string | null>();

  constructor(deps: DoneCleanupDeps) {
    this.deps = deps;
  }

  /**
   * Stage change listener for done tasks: after a short delay the cleanup runs. `mover` is the AI
   * member that made the move: its session finishes the turn it is in first.
   */
  schedule(projectKey: string, taskKey: string, mover: string | null = null): void {
    const key = `${projectKey}:${taskKey}`;
    // A pending timer is kept (the timers ignore a second arm of the key); the latest member who moved the task is
    // the one whose turn the cleanup waits for.
    if (mover || !this.movers.has(key)) this.movers.set(key, mover);
    this.deps.timers.arm('cleanup', key, this.deps.delayMs, () => {
      const moved = this.movers.get(key) ?? null;
      this.movers.delete(key);
      this.run(projectKey, taskKey, moved);
    });
  }

  run(projectKey: string, taskKey: string, mover: string | null = null): void {
    this.deps
      .background(() => this.cleanUp(projectKey, taskKey, { mover }))
      .catch((err: unknown) => this.deps.ctx.logger.warn({ err, taskKey }, 'cleanup of a done task failed'));
  }

  /**
   * Stops a done task's sessions and removes its worktrees unless they hold uncommitted or unpushed
   * work. The session of `mover` that is still in a turn (it moved the task, and its messages and
   * notes may follow) is left to finish it: the cleanup runs again when it is idle or ended, or
   * after `DONE_TASK_TURN_LIMIT_MS` (PM-190).
   */
  async cleanUp(projectKey: string, taskKey: string, opts: { mover?: string | null } = {}): Promise<void> {
    const { ctx, engines } = this.deps;
    const task = ctx.repos.tasks.get(taskKey);
    if (!task || task.projectKey !== projectKey || task.status !== 'done') return; // reopened meanwhile
    const sessions = ctx.repos.sessions.list(projectKey, { taskKey });
    let finishing = false;
    for (const session of sessions) {
      if (!this.deps.isRunning(session.id)) continue;
      if (opts.mover && session.member === opts.mover && session.state !== 'idle') {
        this.deps.turns.wait(session, taskKey);
        finishing = true;
        continue;
      }
      const stop: SessionStop = { kind: 'card_done', taskKey };
      this.deps.noteStop(session.id, stop);
      try {
        await this.deps.runner.stop(session.id);
      } catch (err) {
        ctx.logger.warn({ err, sessionId: session.id }, 'could not stop a session');
      }
      this.deps.markEnded(session.id, stop);
    }
    // The worktrees go once the finishing session is done with them too.
    if (finishing) return;
    if (ctx.repos.sessionCleanups.forTask(projectKey, taskKey).length) {
      ctx.logger.info(
        { projectKey, taskKey },
        'keeping worktrees while session process cleanup is unresolved',
      );
      return;
    }
    // A member workspace outlives its tasks (PM-138): only per-task worktrees are removed.
    // Each is removed through the engine its session ran on.
    const worktrees = new Map<string, { engineId: EngineId; path: string }>();
    for (const s of sessions) {
      if (s.branch === null || this.deps.inWorkspace(s)) continue;
      worktrees.set(`${engineIdOf(s)}\0${s.cwd}`, { engineId: engineIdOf(s), path: s.cwd });
    }
    for (const { engineId, path } of worktrees.values()) {
      const engine = engines.get(engineId);
      if (!engine) {
        ctx.logger.info({ path, taskKey, engineId }, 'worktree not removed: its engine is offline');
        continue;
      }
      try {
        const status = await engine.worktrees.status(path);
        if (status.dirty || status.unpushedCommits > 0) {
          ctx.logger.info({ path, taskKey, ...status }, 'keeping a worktree with local work');
          continue;
        }
        await engine.worktrees.remove({ path });
      } catch (err) {
        // Expected refusals (WorktreeError codes): local changes, a checkout we do not own.
        const code = errorCode(err);
        const expected = code !== null && KEPT_WORKTREE_CODES.has(code);
        ctx.logger[expected ? 'info' : 'warn']({ err, path, taskKey, code }, 'worktree not removed');
      }
    }
  }
}
