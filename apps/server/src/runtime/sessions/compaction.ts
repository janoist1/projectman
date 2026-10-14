import { DEFAULT_AGENT_PROVIDER, isOpenTask, isWorkingOnTask } from '@projectman/shared';
import type { AgentProvider, Session, Task } from '@projectman/shared';
import { COMPACTING_PROVIDERS } from '../../contracts';
import type { ContextPackBuilder, RunnerEvent, SessionRunner } from '../../contracts';
import type { DomainContext } from '../../core/base';
import type { ProjectService } from '../../core/projects';
import type { TaskService } from '../../core/tasks';

/**
 * A session that owes a compaction (PM-213), idle at the end of its round or stopped and resuming,
 * gets it only if its conversation is bigger than this: its last measured context (input, cache read
 * and cache write of the last step). A fresh session already starts at 52-56k (the PM-209
 * measurement), a fixed share a compaction does not shrink, so a smaller conversation, one that was
 * just compacted included, is not worth the summary. An unknown context counts as small.
 */
export const COMPACT_MIN_CONTEXT_TOKENS = 100_000;

export interface RoundCompactionDeps {
  ctx: DomainContext;
  projects: Pick<ProjectService, 'config'>;
  tasks: Pick<TaskService, 'get'>;
  runner: Pick<SessionRunner, 'compact' | 'hasPendingInput'>;
  contextBuilder: Pick<ContextPackBuilder, 'compactInstruction'>;
  find: (sessionId: string) => Session | null;
  isRunning: (sessionId: string) => boolean;
  isPaused: (session: Pick<Session, 'id' | 'projectKey'>) => boolean;
  /** The session is marked to close (PM-288). */
  closePending: (sessionId: string) => boolean;
  /** A team message for the session is not typed into it yet. */
  messageWaiting: (session: Session) => boolean;
  /** Runs `work` under the session's lock, as a job the manager's shutdown does not wait for. */
  underLock: (session: Session, work: () => Promise<void>) => Promise<unknown>;
}

/** End-of-round compaction (PM-213): a conversation whose round ended is summarised when it idles or resumes. */
export class RoundCompaction {
  private readonly deps: RoundCompactionDeps;

  constructor(deps: RoundCompactionDeps) {
    this.deps = deps;
  }

  /** The text the compaction command takes, when sessions of this provider are compacted at all. */
  instruction(provider: AgentProvider | undefined): string | null {
    const instruction = this.deps.contextBuilder.compactInstruction;
    if (!instruction || !this.deps.runner.compact) return null;
    return COMPACTING_PROVIDERS.has(provider ?? DEFAULT_AGENT_PROVIDER) ? instruction : null;
  }

  /**
   * The card left a stage (`task_stage_changed`): the round of every member's session on it ends
   * when the card is no longer in a stage that member works it in, so that conversation owes a
   * compaction. A session in a turn is compacted once it idles, an idle one now; one that does not
   * run is compacted when it resumes (`firstOnResume`). A member who works the card in the next stage
   * as well goes on in the same conversation, and a card that is done or cancelled needs nothing.
   */
  async roundEnded(task: Task): Promise<void> {
    if (!isOpenTask(task)) return;
    const config = await this.deps.projects.config(task.projectKey);
    for (const session of this.deps.ctx.repos.sessions.list(task.projectKey, { taskKey: task.key })) {
      if (!this.instruction(session.provider)) continue;
      if (isWorkingOnTask(config, task, session.member, 'idle')) continue;
      this.deps.ctx.repos.sessions.setCompactPending(session.id, true);
    }
  }

  /**
   * Compacts the session now if it owes a compaction and is idle, else its next idle moment does.
   * Not one marked to close (PM-288): its conversation is compacted when it resumes.
   */
  whenIdle(session: Session): void {
    const { ctx, closePending, isPaused, underLock } = this.deps;
    if (!ctx.repos.sessions.compaction(session.id).pending) return;
    if (session.state !== 'idle' || isPaused(session) || closePending(session.id)) return;
    underLock(session, () => this.compactIdle(session.id)).catch((err: unknown) =>
      ctx.logger.warn({ err, sessionId: session.id }, 'could not compact the session'),
    );
  }

  /**
   * A conversation whose round ended while its session did not run is compacted before anything else
   * is typed (PM-213), if it is big: the wake-up messages and the continue message follow it. The
   * instruction to type first, or undefined.
   */
  firstOnResume(
    existing: Session | null,
    resume: boolean,
    provider: AgentProvider | undefined,
  ): string | undefined {
    const owed = resume && existing ? this.deps.ctx.repos.sessions.compaction(existing.id) : null;
    const instruction = this.instruction(provider);
    return owed?.pending && instruction && (owed.contextTokens ?? 0) > COMPACT_MIN_CONTEXT_TOKENS
      ? instruction
      : undefined;
  }

  /** The runner reported a compaction of the session's conversation. */
  observe(sessionId: string, event: Extract<RunnerEvent, { type: 'compaction' }>): void {
    const { ctx } = this.deps;
    // The compaction the server asked for is over, or given up: it is not owed any more (PM-213).
    // What the conversation's context is, is measured again from its next step.
    if (event.phase === 'finished') ctx.repos.sessions.setContextTokens(sessionId, null);
    if (event.requested && event.phase !== 'started') ctx.repos.sessions.setCompactPending(sessionId, false);
    ctx.logger.info(
      { sessionId, phase: event.phase, trigger: event.trigger, requested: event.requested },
      'conversation compaction',
    );
  }

  /**
   * Types the compaction command into an idle session whose round ended, unless something is on its
   * way into it: a message goes first, and the compaction waits for the session's next idle moment.
   * The caller holds the session's lock.
   */
  private async compactIdle(sessionId: string): Promise<void> {
    const { ctx, find, isRunning, messageWaiting, runner } = this.deps;
    const ready = (s: Session | null): s is Session =>
      Boolean(
        s &&
        s.workItem.type === 'task' &&
        s.state === 'idle' &&
        isRunning(s.id) &&
        ctx.repos.sessions.compaction(s.id).pending &&
        !runner.hasPendingInput?.(s.id) &&
        !messageWaiting(s),
      );
    if (!ready(find(sessionId))) return;
    const found = find(sessionId)!;
    const config = await this.deps.projects.config(found.projectKey);
    const session = find(sessionId);
    if (!ready(session) || session.workItem.type !== 'task') return;
    const instruction = this.instruction(session.provider);
    if (!instruction) return;
    const task = this.deps.tasks.get(session.projectKey, session.workItem.taskKey);
    if (isWorkingOnTask(config, task, session.member, 'idle')) {
      // The card is back in a stage the member works it in: the conversation goes on with it.
      ctx.repos.sessions.setCompactPending(session.id, false);
      return;
    }
    if (!isOpenTask(task)) return;
    // A small conversation is not worth a summary (a just compacted one is small): nothing is owed.
    const { contextTokens } = ctx.repos.sessions.compaction(session.id);
    if ((contextTokens ?? 0) <= COMPACT_MIN_CONTEXT_TOKENS) {
      ctx.repos.sessions.setCompactPending(session.id, false);
      return;
    }
    const asked = await runner.compact!(session.id, instruction);
    ctx.logger.info(
      { sessionId: session.id, taskKey: task.key, asked },
      asked ? 'compacting the conversation at the end of its round' : 'the compaction was not asked for',
    );
  }
}
