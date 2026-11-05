import {
  SENIOR_WAIT_OPTIONS,
  complexityOf,
  coordinationMemberOf,
  isOpenTask,
  ownerHandles,
  seniorWaitEndReasonOf,
  seniorWaitMinutesOf,
} from '@projectman/shared';
import type { SeniorWaitDecisionPayload } from '@projectman/shared';
import { getLocale } from '@projectman/templates';
import { isoNow } from '../../core/base';
import type { DomainContext } from '../../core/base';
import type { InboxService } from '../../core/inbox';
import type { TaskService } from '../../core/tasks';
import { announceNoSenior } from '../../core/timeline';
import type { TimelineService } from '../../core/timeline';
import { SYSTEM_ACTOR } from '../../kernel';
import type { DerivedObligation, ObligationSource } from './sources';
import type { ObligationPmNotices } from './ports';

interface SeniorWaitDeps {
  ctx: DomainContext;
  inbox: Pick<InboxService, 'create' | 'resolveByRule' | 'applyRoute'>;
  timeline: Pick<TimelineService, 'append' | 'latest'>;
  tasks: Pick<TaskService, 'find' | 'publish'>;
  /** The project manager's signal line, wired by the assembly after the services exist. */
  notices: () => ObligationPmNotices | null;
}

const WAITING = 'senior_busy';

/**
 * The wait of a scored card for a developer whose limit reaches its points (PM-348, PM-1001, PM-1150,
 * decisions K2 and K3 of PM-338). While every such developer is busy or away the start of the card is a
 * deferred start that waits (`senior_busy`); this is the step it tracks, with no AI responsible: after
 * the wait limit (`seniorWaitMinutes`, 30 by default) the project manager gets a `senior_wait` signal and
 * decides with `decide_senior_wait`, wait on or let a free developer take the card (the owners get the
 * question only on a project without a project manager). It has only the hand-over rung, and no hold of
 * the card stops its clock.
 *
 * The row ends when the card no longer waits for such a developer (it was assigned, moved, closed, lost
 * its points, or the roster changed); a developer who takes it ends the step as fulfilled and closes the
 * question. An undecided wait leaves the card waiting.
 */
export function seniorWaitSource(deps: SeniorWaitDeps): ObligationSource {
  const { ctx } = deps;

  return {
    kind: 'senior_wait',
    rungs: ['hand_over'],
    minutesOf: (config) => seniorWaitMinutesOf(config.team.limits),
    pausable: false,
    derive(project) {
      const found: DerivedObligation[] = [];
      const rows = new Map(
        project.live.filter((row) => row.kind === 'senior_wait').map((row) => [row.taskKey, row]),
      );
      for (const task of project.tasks.values()) {
        if (!isOpenTask(task)) continue;
        const row = rows.get(task.key);
        const waiting = task.startWaiting?.reason === WAITING ? task.startWaiting : null;
        // An open step ends only by the end reasons: the card may show another wait or a hold for a while
        // (`startWaiting` is one at a time) and shows this one again; the step, its question and its
        // answer must not be lost meanwhile.
        if (!waiting && !row) continue;
        if (seniorWaitEndReasonOf(task, project.config) !== null) continue;
        const since = row?.openedAt ?? waiting!.since;
        found.push({
          taskKey: task.key,
          responsible: null,
          subject: row?.subject ?? `${WAITING}@${since}`,
          since,
        });
      }
      return found;
    },
    closedAs: (row, project) => {
      const task = project.tasks.get(row.taskKey);
      return task && seniorWaitEndReasonOf(task, project.config) === 'senior' ? 'fulfilled' : 'cancelled';
    },
    async handOver(row, project) {
      const task = project.tasks.get(row.taskKey);
      // The card does not show the wait now: the next round ends the step.
      if (!task || task.startWaiting?.reason !== WAITING) return 'settled';
      const config = project.config;
      const seniors = task.startWaiting.seniors ?? [];
      const minutes = seniorWaitMinutesOf(config.team.limits);
      const points = complexityOf(task);
      const now = isoNow(ctx);
      // The project manager decides (PM-1251, PM-1241 7.14): the owners only on a project without one, under
      // the `cost` topic, because more capacity is what the answer may need.
      const applied = deps.inbox.applyRoute(config, { kind: 'senior_wait', topic: { ownerTopic: 'cost' } });
      if (applied.route.to === 'pm') {
        const notices = deps.notices();
        const pm = coordinationMemberOf(config);
        if (!notices || !pm) throw new Error('no project manager notices are wired');
        ctx.unitOfWork(() => {
          notices.raiseSeniorWait({ projectKey: task.projectKey, taskKey: task.key, obligationId: row.id });
          ctx.repos.obligations.update(row.id, { handedOverAt: now, pmToldAt: now }, now);
          deps.timeline.append({
            projectKey: task.projectKey,
            taskKey: task.key,
            actor: SYSTEM_ACTOR,
            type: 'task_senior_wait',
            data: {
              phase: 'asked',
              minutes,
              seniors,
              deciders: [pm.handle],
              ...(points === null ? {} : { points }),
            },
          });
          ctx.journal.record(task.projectKey, 'task', task.key);
        });
        try {
          await notices.deliver(task.projectKey);
        } catch (err) {
          ctx.logger.warn(
            { err, taskKey: task.key },
            'could not deliver the Senior wait signal to the project manager',
          );
        }
        return 'settled';
      }
      const deciders = ownerHandles(config);
      if (deciders.length === 0) {
        // Nobody can be asked: said once, and the card goes on waiting.
        ctx.repos.obligations.update(row.id, { handedOverAt: now }, now);
        ctx.logger.warn(
          { taskKey: task.key },
          'card waits for a Senior past the limit, and the project has no owner to ask',
        );
        return 'settled';
      }
      const payload: SeniorWaitDecisionPayload = {
        taskKey: task.key,
        since: row.openedAt,
        minutes,
        seniors,
        reason: task.complexity?.reason ?? null,
        ...(points === null ? {} : { points }),
      };
      ctx.unitOfWork(() => {
        const item = deps.inbox.create({
          projectKey: task.projectKey,
          kind: 'decision',
          assignees: deciders,
          source: 'system',
          taskKey: task.key,
          title: getLocale(config.project.language).seniorWaitItem.title.replace('{key}', task.key),
          payload: { seniorWait: payload },
          options: SENIOR_WAIT_OPTIONS,
          routed: applied,
        });
        ctx.repos.obligations.update(row.id, { handedOverAt: now, inboxItemId: item.id }, now);
        deps.timeline.append({
          projectKey: task.projectKey,
          taskKey: task.key,
          actor: SYSTEM_ACTOR,
          type: 'task_senior_wait',
          data: { phase: 'asked', minutes, seniors, deciders, ...(points === null ? {} : { points }) },
        });
        ctx.journal.record(task.projectKey, 'task', task.key);
      });
      return 'settled';
    },
    onClosed(row, _outcome, project) {
      const task = project.tasks.get(row.taskKey);
      const reason = task ? seniorWaitEndReasonOf(task, project.config) : 'closed';
      const closed = row.inboxItemId
        ? deps.inbox.resolveByRule(
            row.inboxItemId,
            'ended',
            reason === 'senior' ? 'senior_took' : 'senior_wait_ended',
          )
        : null;
      // The question to the project manager is a signal, not an item: the row says it was told (PM-1251).
      if ((closed || (row.pmToldAt && !row.inboxItemId)) && reason === 'senior')
        deps.timeline.append({
          projectKey: row.projectKey,
          taskKey: row.taskKey,
          actor: SYSTEM_ACTOR,
          type: 'task_senior_wait',
          data: { phase: 'senior_took' },
        });
      if (task && reason === 'no_senior') announceNoSenior(deps.timeline, task);
      ctx.journal.record(row.projectKey, 'task', row.taskKey);
      // The card as it stands now: the wait no longer shows on it.
      const current = deps.tasks.find(row.projectKey, row.taskKey);
      if (current) deps.tasks.publish(current);
    },
  };
}
