import { describe, expect, it } from 'vitest';
import type { InboxItem, Task, TaskDetail, TeamMessage, TimelineEvent } from '@projectman/shared';
import {
  canSeeProjectEvent,
  canSeeTask,
  teamMessageMember,
  visibleTaskDetail,
} from '../src/domain/visibility';
import type { ProjectEvent } from '../src/domain/visibility';

const client = { access: 'client' as const, handle: 'acme-client' };
const developer = { access: 'developer' as const, handle: 'dev' };

const task = (key: string, visibility: Task['visibility']) => ({ key, visibility }) as Task;
const timeline = (type: TimelineEvent['type']) => ({ type }) as TimelineEvent;
const item = (assignees: string[]) => ({ assignees }) as InboxItem;
const message = (from: string, to: string[]) => ({ from, to }) as TeamMessage;

describe('client visibility', () => {
  it('hides internal tasks, their details and internal timeline entries from clients', () => {
    expect(canSeeTask(client, task('AR-1', 'shared'))).toBe(true);
    expect(canSeeTask(client, task('AR-2', 'internal'))).toBe(false);
    expect(canSeeTask(developer, task('AR-2', 'internal'))).toBe(true);
    const detail = {
      task: task('AR-1', 'shared'),
      parent: task('AR-2', 'internal'),
      subtasks: [task('AR-3', 'shared'), task('AR-4', 'internal')],
      pullRequests: [],
      timeline: ['task_created', 'task_note', 'task_stage_changed', 'task_labels_changed'].map((type) =>
        timeline(type as TimelineEvent['type']),
      ),
      sessions: [{ id: 'ses_1' }],
    } as unknown as TaskDetail;
    expect(visibleTaskDetail(developer, detail)).toBe(detail);
    expect(visibleTaskDetail(client, detail)).toEqual({
      task: detail.task,
      parent: null,
      subtasks: [detail.subtasks![0]],
      pullRequests: [],
      timeline: [timeline('task_created'), timeline('task_stage_changed')],
      sessions: [],
    });
  });

  it('limits a client to their own inbox items and messages', () => {
    expect(teamMessageMember(client, 'someone-else')).toBe('acme-client');
    expect(teamMessageMember(developer, 'someone-else')).toBe('someone-else');
    const events: Array<[ProjectEvent, boolean]> = [
      [{ type: 'inbox_upserted', projectKey: 'AR', item: item(['acme-client']) }, true],
      [{ type: 'inbox_upserted', projectKey: 'AR', item: item(['owner']) }, false],
      [{ type: 'team_message', projectKey: 'AR', message: message('owner', ['acme-client']) }, true],
      [{ type: 'team_message', projectKey: 'AR', message: message('acme-client', ['owner']) }, true],
      [{ type: 'team_message', projectKey: 'AR', message: message('owner', ['dev']) }, false],
    ];
    for (const [event, visible] of events) {
      expect(canSeeProjectEvent(client, event)).toBe(visible);
      expect(canSeeProjectEvent(developer, event)).toBe(true);
    }
  });

  it('keeps live timeline events and member state internal (the REST views differ, see the module)', () => {
    const live = [
      { type: 'task_upserted', projectKey: 'AR', task: task('AR-1', 'shared') },
      { type: 'task_upserted', projectKey: 'AR', task: task('AR-2', 'internal') },
      { type: 'timeline_appended', projectKey: 'AR', event: timeline('task_created') },
      { type: 'member_state', projectKey: 'AR', handle: 'dev', status: 'working', activity: null },
      { type: 'member_changed', projectKey: 'AR', handle: 'dev', member: null },
      { type: 'config_changed', projectKey: 'AR', version: 'abc' },
    ] as ProjectEvent[];
    expect(live.map((event) => canSeeProjectEvent(client, event))).toEqual([
      true,
      false,
      false,
      false,
      true,
      true,
    ]);
  });
});
