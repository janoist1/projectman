import { z } from 'zod';
import { memberOf, stageOf, TaskStartWaiting } from '@projectman/shared';
import type { DomainContext } from '../../core/base';
import { isoNow } from '../../core/base';
import type { MemberQueue } from '../../core/member-queue';
import type { ProjectService } from '../../core/projects';
import type { DeferredStartRecord, StoredMemberQueueItem } from '../../db';
import { newId } from '../../kernel';
import { StartSpec } from './deferred-starts';
import type { DeferredStart } from './deferred-starts';

const StartPayload = z.object({ key: z.string(), spec: StartSpec, waiting: TaskStartWaiting });

interface StartQueueDeps {
  ctx: DomainContext;
  projects: Pick<ProjectService, 'cachedConfig'>;
  queue: Pick<MemberQueue, 'publish' | 'closeStart' | 'enqueued'>;
}

/** The queue-backed part of DeferredStarts; the facade still owns its in-flight retry view. */
export class StartQueue {
  private readonly deps: StartQueueDeps;
  constructor(deps: StartQueueDeps) {
    this.deps = deps;
  }

  /** Moving a start between the queue and the legacy table must not leave a crash window. */
  persist(write: () => void): void {
    this.deps.ctx.unitOfWork(write);
  }

  /** False: no known AI member yet, so the legacy store still owns this start. */
  keep({ start, waiting }: DeferredStart): boolean {
    const { ctx, projects, queue } = this.deps;
    const member = start.waitsFor();
    const config = projects.cachedConfig(start.projectKey);
    if (!member || !config || memberOf(config, member)?.kind !== 'ai') {
      this.retire(start.key);
      return false;
    }
    ctx.unitOfWork(() => {
      // A retry may pick another reviewer. Only the selected member owes this start now.
      const open = this.items(start.key);
      for (const old of open)
        if (old.member !== member) {
          ctx.repos.memberQueue.closeBySource(old.projectKey, old.source, {
            member: old.member,
            state: 'cancelled',
            reason: 'stale',
            at: isoNow(ctx),
          });
          queue.publish(old.projectKey, old.member);
        }
      const task = start.taskKey ? ctx.repos.tasks.get(start.taskKey) : null;
      const title = task
        ? `${task.key} · ${task.title} · ${stageOf(config, task.stageId)?.name ?? task.stageId}`
        : start.key;
      const id = newId('mqi');
      const item = {
        id,
        projectKey: start.projectKey,
        member,
        source: { type: 'start' as const, id: `${start.key}#${id}` },
        kind: 'start' as const,
        place: start.taskKey
          ? { type: 'task' as const, taskKey: start.taskKey }
          : { type: 'general' as const },
        taskKey: start.taskKey,
        wake: true,
        title: title.slice(0, 200),
        from: null,
        queuedAt: waiting.since,
        payload: { key: start.key, spec: start.spec(), waiting },
      };
      let stored = open.find((item) => item.member === member);
      const inserted = !stored;
      if (!stored) {
        ctx.repos.memberQueue.insert(item);
        stored = ctx.repos.memberQueue.get(id)!;
      }
      ctx.repos.memberQueue.setPayload(stored.id, item.payload);
      const { reason, since, ...details } = waiting;
      ctx.repos.memberQueue.setWait(
        stored.id,
        task?.labels.includes('waiting-answer') ? 'hold_waiting_answer' : reason,
        since,
        details,
      );
      if (inserted) queue.enqueued(start.projectKey, member);
      else queue.publish(start.projectKey, member);
    });
    return true;
  }

  close(key: string, started: boolean): void {
    for (const item of this.items(key))
      this.deps.queue.closeStart(item, started ? 'started' : 'source_closed');
  }

  has(key: string): boolean {
    return this.items(key).length > 0;
  }

  private items(key: string): StoredMemberQueueItem[] {
    return this.deps.ctx.repos.memberQueue
      .listOpenOfType('start')
      .filter((item) => (this.payload(item)?.key ?? item.source.id) === key);
  }

  private retire(key: string): void {
    const { ctx, queue } = this.deps;
    for (const item of this.items(key)) {
      ctx.repos.memberQueue.closeBySource(item.projectKey, item.source, {
        state: 'cancelled',
        reason: 'stale',
        at: isoNow(ctx),
        member: item.member,
      });
      queue.publish(item.projectKey, item.member);
    }
  }

  records(): DeferredStartRecord[] {
    return this.deps.ctx.repos.memberQueue.listOpenOfType('start').map((item) => {
      const payload = this.payload(item);
      return {
        key: payload?.key ?? item.source.id,
        projectKey: item.projectKey,
        taskKey: item.taskKey,
        spec: payload?.spec,
        waiting: payload?.waiting,
      };
    });
  }

  payload(item: StoredMemberQueueItem): z.infer<typeof StartPayload> | null {
    const parsed = StartPayload.safeParse(this.deps.ctx.repos.memberQueue.payload(item.id));
    return parsed.success ? parsed.data : null;
  }

  held(start: DeferredStart['start']): boolean {
    return (
      !!start.taskKey && !!this.deps.ctx.repos.tasks.get(start.taskKey)?.labels.includes('waiting-answer')
    );
  }
}
