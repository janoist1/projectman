import type { InvolvementQuery, InvolvementsResponse } from '@projectman/shared';
import type { DomainContext } from './context';
import { invalid } from './errors';
import { visibleTimelineEvent } from './visibility';
import type { Viewer } from './visibility';

export class InvolvementService {
  constructor(ctx: DomainContext) {
    this.ctx = ctx;
  }
  private readonly ctx: DomainContext;

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
      items: result.events.map((event) => ({
        event: visibleTimelineEvent(viewer, event, (id) => this.ctx.repos.messages.get(id)),
        taskTitle: event.taskKey ? (this.ctx.repos.tasks.get(event.taskKey)?.title ?? null) : null,
      })),
      counts: result.counts,
      nextBefore:
        result.more && last ? Buffer.from(`${last.createdAt}|${last.id}`).toString('base64url') : null,
    };
  }
}
