import {
  ALERT_SEEN_OPTION,
  alertPayloadOf,
  messageBurstAlertFor,
  messageBurstOf,
  messageBurstSince,
} from '@projectman/shared';
import type { InboxItem, TimelineEvent } from '@projectman/shared';
import { ownerHandles } from './access';
import type { DomainContext } from './context';
import type { InboxService } from './inbox';
import type { ProjectService } from './projects';

/** The most entries of a card read at once: far more than a threshold (100 at most) needs. */
const TALK_LIMIT = 1000;

/**
 * The message storm warning (PM-186, rule 5 of PM-176). Every team message and note recorded on a
 * card is counted with the ones before it in the last `minutes` minutes (the project's
 * `messageBurst`, 10 in 15 by default); once that reaches `count`, the owners get one `alert` in
 * their inbox naming the card, the count, the window and the members who took part. People
 * talking among themselves count too. Imported comments do not. The rule itself (one alert per
 * storm, a new one only after a whole window of quiet) is `messageBurstAlertFor` in
 * `packages/shared`. Nothing is stopped or held back.
 */
export class MessageBurstWatch {
  private readonly ctx: DomainContext;
  private readonly projects: ProjectService;
  private readonly inbox: InboxService;

  constructor(deps: { ctx: DomainContext; projects: ProjectService; inbox: InboxService }) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.inbox = deps.inbox;
  }

  /** After a message or a note was recorded: the alert item when this entry raised one, else null. */
  check(event: TimelineEvent): InboxItem | null {
    const { projectKey, taskKey } = event;
    if (!taskKey) return null;
    const config = this.projects.cachedConfig(projectKey);
    const owners = config ? ownerHandles(config) : [];
    if (!config || owners.length === 0) return null;
    const burst = messageBurstOf(config.team.limits);
    const now = this.ctx.now();
    const earlier = this.inbox.list(projectKey, { kind: 'alert', taskKey }).flatMap((item) => {
      const payload = alertPayloadOf(item);
      return payload?.alert === 'message_burst' ? [{ open: item.state === 'open', at: payload.at }] : [];
    });
    // With an earlier alert the whole conversation since it is needed, to find a quiet window in it;
    // a list cut short begins later, and the rule is told where.
    const lastAlert = earlier.reduce<string | null>((at, a) => (at === null || a.at > at ? a.at : at), null);
    const entries = this.ctx.repos.timeline.talkSince(
      projectKey,
      taskKey,
      lastAlert ?? messageBurstSince(burst, now),
      TALK_LIMIT,
    );
    const payload = messageBurstAlertFor({
      taskKey,
      burst,
      now,
      earlier,
      ...(entries.length >= TALK_LIMIT ? { coveredFrom: entries[0]!.createdAt } : {}),
      entries: entries.map((entry) => ({
        createdAt: entry.createdAt,
        actor: entry.actor.handle,
        to: Array.isArray(entry.data.to) ? entry.data.to.filter((to) => typeof to === 'string') : [],
      })),
    });
    if (!payload) return null;
    return this.inbox.create({
      projectKey,
      kind: 'alert',
      assignees: owners,
      source: event.actor.handle ?? 'system',
      taskKey,
      title: `${payload.count} messages and notes on ${taskKey} in ${payload.minutes} minutes`,
      payload,
      options: [ALERT_SEEN_OPTION],
    });
  }
}
