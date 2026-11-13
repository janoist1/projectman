import { isOpenTask, isTheme, mayInvolveMembers } from '@projectman/shared';
import type { Actor, InvolvementQuery, InvolvementsResponse } from '@projectman/shared';
import type { DomainContext } from '../base';
import { invalid, memberInvolvementRefused, notFound } from '../../kernel';
import { requireAiMember } from '../members';
import { canSeeTimelineEvent, visibleTimelineEvent } from '../projects';
import type { ProjectService, Viewer } from '../projects';
import type { TimelineService } from '../timeline';

/** What `involve` did: `already_involved` wrote nothing; `waiting` is the messages queued for the member on the card. */
export interface InvolveResult {
  outcome: 'involved' | 'already_involved';
  waiting: number;
}

export class InvolvementService {
  constructor(deps: {
    ctx: DomainContext;
    timeline: Pick<TimelineService, 'append'>;
    projects: Pick<ProjectService, 'config'>;
  }) {
    this.ctx = deps.ctx;
    this.timeline = deps.timeline;
    this.projects = deps.projects;
  }
  private readonly ctx: DomainContext;
  private readonly timeline: Pick<TimelineService, 'append'>;
  private readonly projects: Pick<ProjectService, 'config'>;

  /**
   * Involves an AI member on a card (PM-1267): a role it had no other way to get, so a message to it
   * wakes its session. Only the actors `mayInvolveMembers` names may; a person's own message needs
   * no involvement. It grants no label or approval right, which never read the card role.
   */
  async involve(
    projectKey: string,
    taskKey: string,
    member: string,
    reason: string,
    actor: Actor,
  ): Promise<InvolveResult> {
    const config = await this.projects.config(projectKey);
    if (!mayInvolveMembers(config, actor)) throw memberInvolvementRefused();
    requireAiMember(config, member);
    if (member === actor.handle)
      throw invalid('invalid_request', `${member} cannot involve itself: it acts on its own cards already`);
    const task = this.ctx.repos.tasks.get(taskKey);
    if (!task || task.projectKey !== projectKey) throw notFound('task', taskKey);
    if (isTheme(task)) throw invalid('task_is_theme', `${taskKey} is a theme: members work on its cards`);
    if (!isOpenTask(task)) throw invalid('invalid_request', `${taskKey} is closed`);
    const waiting = () =>
      this.ctx.repos.memberQueue
        .listOpen(projectKey, member)
        .filter((item) => item.kind === 'message' && item.taskKey === taskKey).length;
    if (this.ctx.repos.timeline.involvedOn(projectKey, [taskKey], member))
      return { outcome: 'already_involved', waiting: waiting() };
    this.ctx.unitOfWork(() => {
      this.timeline.append({
        projectKey,
        taskKey,
        actor,
        type: 'member_involved',
        data: { member, reason },
      });
      this.ctx.afterCommit(
        () => void this.ctx.events.emit('member_involved', { projectKey, taskKey, member }),
      );
    });
    return { outcome: 'involved', waiting: waiting() };
  }

  list(projectKey: string, query: InvolvementQuery, viewer: Viewer): InvolvementsResponse {
    let cursor: [string, string] | undefined;
    if (query.before) {
      const decoded = Buffer.from(query.before, 'base64url').toString('utf8');
      const parts = decoded.split('|');
      if (parts.length !== 2 || !parts[0] || !parts[1] || !Number.isFinite(Date.parse(parts[0])))
        throw invalid('invalid_request', 'Invalid involvement cursor');
      cursor = [parts[0], parts[1]];
    }
    const result = this.ctx.repos.timeline.involvements(projectKey, query, cursor);
    const last = result.events.at(-1);
    return {
      items: result.events
        .filter((event) => canSeeTimelineEvent(viewer, event, (id) => this.ctx.repos.messages.get(id)))
        .map((event) => ({
          event: visibleTimelineEvent(viewer, event, (id) => this.ctx.repos.messages.get(id)),
          taskTitle: event.taskKey ? (this.ctx.repos.tasks.get(event.taskKey)?.title ?? null) : null,
        })),
      counts: result.counts,
      nextBefore:
        result.more && last ? Buffer.from(`${last.createdAt}|${last.id}`).toString('base64url') : null,
    };
  }
}
