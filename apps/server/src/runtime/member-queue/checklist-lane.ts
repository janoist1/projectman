import { operatorOf } from '@projectman/shared';
import type { DomainContext } from '../../core/base';
import type { MemberQueue } from '../../core/member-queue';
import type { ProjectService } from '../../core/projects';
import type { StoredMemberQueueItem } from '../../db';
import type { MemberQueueLane } from './lane';

/** Checklist notices use the ordinary queue's delivery, login waits and engine admission. */
export function checklistLane(deps: {
  ctx: DomainContext;
  projects: Pick<ProjectService, 'cachedConfig'>;
  memberQueue: Pick<MemberQueue, 'add'>;
}): MemberQueueLane {
  const { ctx, projects, memberQueue } = deps;
  const enqueue = (projectKey: string, noticeId: string, title: string) => {
    const config = projects.cachedConfig(projectKey);
    const operator = config && operatorOf(config);
    if (!operator) return;
    memberQueue.add({
      projectKey,
      member: operator.handle,
      kind: 'checklist',
      source: { type: 'checklist', id: noticeId },
      place: { type: 'general' },
      taskKey: null,
      wake: true,
      title: title.slice(0, 200),
      from: null,
    });
  };
  // ChecklistService registers first; domain events await each listener, including initialization.
  ctx.events.on('project_created', ({ projectKey }) => {
    if (ctx.repos.checklists.get(projectKey)) enqueue(projectKey, 'onboarding', 'Project onboarding');
  });
  ctx.events.on('checklist_item_reopened', ({ projectKey, itemId, at }) => {
    const item = ctx.repos.checklists.get(projectKey)?.items.find((item) => item.id === itemId);
    if (item) enqueue(projectKey, `reopen:${itemId}@${at}`, item.title);
  });
  const reopenedItem = (item: StoredMemberQueueItem) => {
    const id = item.source.id.slice('reopen:'.length, item.source.id.lastIndexOf('@'));
    return ctx.repos.checklists.get(item.projectKey)?.items.find((entry) => entry.id === id);
  };
  return {
    kinds: ['checklist'],
    completion: 'delivery',
    oneAtATime: false,
    cause: () => ({ kind: 'member_queue' }),
    appliesTo: (item, config) => operatorOf(config)?.handle === item.member,
    render: (item) => {
      if (item.source.id === 'onboarding')
        return 'This project is new. First call get_checklist. Then send the owner a short introduction and one first question with your recommendation using send_message (kind info, in the project language). Guide setup step by step using the checklist and existing tools and approval levels.';
      const reopened = reopenedItem(item);
      return `Checklist item reopened: ${JSON.stringify(reopened?.title)}. Reason: ${reopened?.reopened === 'condition' ? 'its condition no longer holds' : 'the owner reopened it'}. Call get_checklist and look into it; existing authority and approvals still apply.`;
    },
    stillOwed: (item) => {
      if (item.source.id === 'onboarding')
        return (
          ctx.repos.checklists.get(item.projectKey)?.items.some((entry) => entry.state === 'open') ?? false
        );
      const reopened = reopenedItem(item);
      return reopened?.state === 'open' && reopened.reopened !== null;
    },
    hold: async () => null,
  };
}
