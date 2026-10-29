import { z } from 'zod';
import type { SessionStartCause } from '@projectman/shared';
import { memberOf } from '@projectman/shared';
import type { DomainContext } from '../../core/base';
import type { ProjectService } from '../../core/projects';
import type { StoredMemberQueueItem } from '../../db';
import type { Admission, AutomaticStart, DeferredStarts, StartQueue, StartSpec } from '../admission';
import type { MemberQueueLane } from './lane';

interface StartLaneDeps {
  ctx: DomainContext;
  queue: StartQueue;
  deferred: DeferredStarts;
  admission: Pick<Admission, 'attempt' | 'retryHold' | 'warm'>;
  projects: Pick<ProjectService, 'cachedConfig'>;
  rebuild(spec: StartSpec): AutomaticStart | null;
}

const Reminder = z.object({ text: z.string() });

/** Deferred specifications start themselves; obligation reminders use the driver's normal text delivery. */
export function startLane(deps: StartLaneDeps): MemberQueueLane {
  const taskOf = (item: StoredMemberQueueItem) =>
    item.taskKey ? deps.ctx.repos.tasks.get(item.taskKey) : null;
  const startOf = (item: StoredMemberQueueItem) => {
    const payload = deps.queue.payload(item);
    return payload ? deps.rebuild(payload.spec) : null;
  };
  const cause = (item: StoredMemberQueueItem): SessionStartCause => {
    const spec = deps.queue.payload(item)?.spec;
    if (!spec) return { kind: 'member_queue' };
    switch (spec.kind) {
      case 'hand_over':
        return { kind: 'hand_over', from: spec.from, to: spec.to, by: spec.actor, eventId: spec.eventId };
      case 'work_start':
        return { kind: 'start_button', by: spec.actor };
      case 'provider_resume':
        return { kind: 'provider_resume' };
      case 'refinement_turn':
        return { kind: 'refinement', labels: [spec.label] };
      case 'handoff_takeover':
        return { kind: 'handoff', to: spec.handle };
      case 'loop_notice':
        return { kind: 'loop', loopId: spec.loopId };
      case 'operator_signals':
        return { kind: 'operator_signal' };
      case 'question_screening':
        return { kind: 'question_screening' };
      case 'message_wake':
        return { kind: 'message' };
    }
  };
  return {
    kinds: ['start'],
    completion: 'start',
    oneAtATime: false,
    cause,
    render: (item) => {
      if (item.source.type !== 'obligation') return null;
      const payload = Reminder.safeParse(deps.ctx.repos.memberQueue.payload(item.id));
      return payload.success ? payload.data.text : null;
    },
    stillOwed: (item) => {
      if (item.source.type === 'obligation') {
        const row = deps.ctx.repos.obligations.get(item.source.id);
        return (
          !!row && (row.state === 'open' || row.state === 'handed_over') && row.responsible === item.member
        );
      }
      const start = startOf(item);
      const config = deps.projects.cachedConfig(item.projectKey);
      const valid =
        !!config && memberOf(config, item.member)?.kind === 'ai' && !!start && start.stillValid(taskOf(item));
      if (!valid) {
        const key = deps.queue.payload(item)?.key;
        if (key) deps.deferred.drop(key);
      }
      return valid;
    },
    hold: async (item) => {
      const task = taskOf(item);
      if (task?.labels.includes('waiting-answer')) return 'hold_waiting_answer';
      const payload = deps.queue.payload(item);
      const start = payload ? startOf(item) : null;
      return start && payload ? deps.admission.retryHold({ start, waiting: payload.waiting }) : null;
    },
    attemptStart: async (item) => {
      const start = startOf(item);
      if (!start) return { kind: 'closed' };
      try {
        await deps.admission.warm(item.projectKey, item.member);
        const result = await deps.admission.attempt(start);
        return result.kind === 'deferred'
          ? { kind: 'deferred', code: result.waiting.reason }
          : { kind: 'started' };
      } catch (err) {
        // Admission dropped the non-deferrable start together with its audit entry.
        deps.ctx.logger.warn({ err, ...start.log.fields() }, start.log.retryFailed);
        return { kind: 'closed' };
      }
    },
  };
}
