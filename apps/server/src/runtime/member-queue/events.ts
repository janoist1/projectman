import type { DomainContext } from '../../core/base';
import type { MemberQueue } from '../../core/member-queue';
import type { EngineDirectory } from '../../contracts';
import type { BackgroundTasks } from '../../kernel';
import type { MemberQueueDriver } from './lane';

/** Wake queued members after a hold lifts or their work changes. Never await under admission's lock. */
export function wireMemberQueue(deps: {
  ctx: DomainContext;
  background: BackgroundTasks;
  memberQueueDriver: Pick<MemberQueueDriver, 'ensure'>;
  memberQueue: Pick<MemberQueue, 'onChange'>;
  engines: Pick<EngineDirectory, 'onChange'>;
  providerKeys?: { onChange(listener: () => void): unknown } | null;
  standby?: boolean;
}): void {
  const { ctx, background, memberQueueDriver, memberQueue, engines, providerKeys, standby } = deps;
  const { events, logger } = ctx;
  const ensureMember = (projectKey: string, member: string, deliver = true): void => {
    if (standby) return;
    background.run(
      () => memberQueueDriver.ensure(projectKey, member, { deliver }),
      (err) => logger.warn({ err, projectKey, member }, 'working the member queue failed'),
    );
  };
  const ensureMembersOfCard = (projectKey: string, taskKey: string): void => {
    const members = new Set(
      ctx.repos.memberQueue
        .listOpenMembers()
        .filter(
          (open) =>
            open.projectKey === projectKey &&
            ctx.repos.memberQueue
              .listOpen(projectKey, open.member)
              .some(
                (item) =>
                  item.taskKey === taskKey || (item.place.type === 'task' && item.place.taskKey === taskKey),
              ),
        )
        .map((open) => open.member),
    );
    for (const member of members) ensureMember(projectKey, member);
  };
  /** Every member of the project (all projects: none given) that has an open item. */
  const ensureMembers = (projectKey?: string): void => {
    for (const open of ctx.repos.memberQueue.listOpenMembers())
      if (projectKey === undefined || open.projectKey === projectKey)
        ensureMember(open.projectKey, open.member);
  };
  // A pause ended, an outage ended or the configuration changed (leave, limits, the provider): holds may have lifted.
  events.on('pause_changed', ({ projectKey }) => ensureMembers(projectKey));
  events.on('work_outage_ended', ({ projectKey }) => ensureMembers(projectKey));
  events.on('config_changed', ({ projectKey }) => ensureMembers(projectKey));
  engines.onChange((_id, online) => {
    if (online) ensureMembers();
  });
  providerKeys?.onChange(() => ensureMembers());
  memberQueue.onChange((projectKey, member) => ensureMember(projectKey, member, false));
  events.on('message_waiting', ({ projectKey, handle }) => ensureMember(projectKey, handle));
  events.on('session_started', (session) => ensureMember(session.projectKey, session.member));
  events.on('session_idle', (session) => ensureMember(session.projectKey, session.member));
  events.on('session_ended', (session) => ensureMember(session.projectKey, session.member));
  events.on('session_input_released', (session) => ensureMember(session.projectKey, session.member));
  // A card that closed, moved or was relabelled changes what its queued messages are worth and hold for.
  events.on('task_cancelled', (task) => ensureMembersOfCard(task.projectKey, task.key));
  events.on('task_stage_changed', ({ task }) => ensureMembersOfCard(task.projectKey, task.key));
  events.on('task_labels_changed', ({ task }) => ensureMembersOfCard(task.projectKey, task.key));
}
