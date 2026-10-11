import { operatorOf, projectDocsOf, SYSTEM_SENDER } from '@projectman/shared';
import type { DomainContext } from './context';
import type { DomainEventMap } from './events';
import type { Messaging } from './messaging';
import type { ProjectService } from './projects';
import { SYSTEM_ACTOR } from './util';

/**
 * A proposed release is a moment to compare the roadmap with the board (PM-497). The Operator is told with
 * a stored `info` message from the system: it wakes nobody, and reaches the Operator with the owner's
 * next message, which is when the Operator offers the comparison. Writing stays with the owner's yes.
 * It goes out once per release: the message holds the release's id, and a release that already has its
 * message gets no second one.
 */
export class ReleaseRoadmapNotices {
  private readonly ctx: DomainContext;
  private readonly projects: ProjectService;
  private readonly messaging: Messaging;

  constructor(deps: { ctx: DomainContext; projects: ProjectService; messaging: Messaging }) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.messaging = deps.messaging;
  }

  async proposed({ release }: DomainEventMap['release_proposed']): Promise<void> {
    if (release.state !== 'proposed') return;
    const config = await this.projects.config(release.projectKey);
    if (!projectDocsOf(config)?.roadmap) return;
    const operator = operatorOf(config);
    if (!operator) return;
    const marker = `(${release.id})`;
    if (this.ctx.repos.messages.hasNote(release.projectKey, SYSTEM_SENDER, operator.handle, marker)) return;
    const name = this.ctx.repos.tasks.get(release.taskKey)?.title ?? release.taskKey;
    await this.messaging.send(
      release.projectKey,
      SYSTEM_SENDER,
      {
        to: [operator.handle],
        taskKey: null,
        text: `Release ${name} ${marker} was proposed. At the owner's next message, offer to compare the roadmap with the board; update it with write_project_docs only after the owner says yes.`,
      },
      { kind: 'info', actor: SYSTEM_ACTOR },
    );
  }
}
