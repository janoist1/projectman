import { isOpenTask } from '@projectman/shared';
import type { OperatorSignal, ReviewFollowUpsFacts, Task } from '@projectman/shared';
import type { DomainContext } from '../../core/base';
import type { OperatorSignals } from './signals';

/** The most `review_follow_ups` events of one card the signal reads. */
const EVENTS_READ = 1000;

const eventsOf = (ctx: DomainContext, task: Pick<Task, 'projectKey' | 'key'>) =>
  ctx.repos.timeline.listOfTypes(task.projectKey, task.key, ['review_follow_ups'], EVENTS_READ);

/**
 * The facts of a `review_follow_ups` signal (PM-1362): one item per remark of the events its subject names
 * (their ids, comma separated), with the card's title and how it closed. Null when the card is gone or open.
 */
export function reviewFollowUpsFacts(
  ctx: DomainContext,
  signal: Pick<OperatorSignal, 'taskKey' | 'subject'>,
): ReviewFollowUpsFacts | null {
  const task = signal.taskKey ? ctx.repos.tasks.get(signal.taskKey) : null;
  if (!task || (task.status !== 'done' && task.status !== 'cancelled')) return null;
  const covered = new Set((signal.subject ?? '').split(',').filter(Boolean));
  const items: ReviewFollowUpsFacts['items'] = [];
  for (const event of eventsOf(ctx, task)) {
    if (!covered.has(event.id)) continue;
    const label = typeof event.data.label === 'string' ? event.data.label : null;
    const texts = Array.isArray(event.data.items) ? event.data.items : [];
    for (const text of texts)
      if (typeof text === 'string')
        items.push({
          eventId: event.id,
          by: event.actor.handle ?? event.actor.kind,
          label,
          at: event.createdAt,
          text,
        });
  }
  return { taskKey: task.key, title: task.title, status: task.status, items };
}

/**
 * Hands the non-blocking remarks reviewers left on a card to the project manager when the card closes
 * (PM-1362): one `review_follow_ups` signal for the remarks no earlier signal of the card covers, so a card
 * that is reopened and closed again passes on only what is new.
 */
export class ReviewFollowUps {
  private readonly ctx: DomainContext;
  private readonly signals: Pick<OperatorSignals, 'raise'>;
  constructor(deps: { ctx: DomainContext; signals: Pick<OperatorSignals, 'raise'> }) {
    this.ctx = deps.ctx;
    this.signals = deps.signals;
  }

  /** Synchronous on purpose: a listener that returns a promise holds back the ones registered after it. */
  cardClosed(task: Task): void {
    if (isOpenTask(task)) return;
    const { ctx } = this;
    const covered = new Set(
      ctx.repos.operatorSignals
        .listOfTask(task.projectKey, task.key, 'review_follow_ups')
        .flatMap((signal) => (signal.subject ?? '').split(',')),
    );
    const fresh = eventsOf(ctx, task).filter((event) => !covered.has(event.id));
    if (fresh.length === 0) return;
    this.signals.raise({
      projectKey: task.projectKey,
      kind: 'review_follow_ups',
      caseKey: `review_follow_ups:${task.key}:${fresh.at(-1)!.id}`,
      taskKey: task.key,
      subject: fresh.map((event) => event.id).join(','),
    });
  }
}
