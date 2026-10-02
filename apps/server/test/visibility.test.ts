import { describe, expect, it } from 'vitest';
import type { InboxItem, Task, TaskDetail, TeamMessage, TimelineEvent } from '@projectman/shared';
import {
  canSeeProjectEvent,
  canSeeTask,
  teamMessageMember,
  visibleProjectEvent,
  visibleTaskDetail,
  visibleTasks,
} from '../src/domain/visibility';
import type { ProjectEvent } from '../src/domain/visibility';

const client = { access: 'client' as const, handle: 'acme-client' };
const developer = { access: 'developer' as const, handle: 'dev' };

const task = (key: string, visibility: Task['visibility'], links: Task['links'] = []) =>
  ({ key, visibility, links }) as Task;
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

  it('shows a client the links to other cards only for the cards shared with them', () => {
    const pr = { kind: 'pull_request', ref: '7', repo: 'acme/app' } as const;
    const linked = task('AR-1', 'shared', [
      pr,
      { kind: 'prerequisite', ref: 'AR-2' },
      { kind: 'related', ref: 'AR-3' },
      { kind: 'duplicate_of', ref: 'AR-4' },
    ]);
    const others = [task('AR-2', 'internal'), task('AR-3', 'shared'), task('AR-4', 'internal'), linked];
    const [forClient, forDeveloper] = [client, developer].map((viewer) => visibleTasks(viewer, others));
    expect(forClient!.map((t) => t.key)).toEqual(['AR-3', 'AR-1']);
    expect(forClient![1]!.links).toEqual([pr, { kind: 'related', ref: 'AR-3' }]);
    expect(forDeveloper!.find((t) => t.key === 'AR-1')!.links).toHaveLength(4);

    const detail = { task: linked, subtasks: [linked], timeline: [], sessions: [] } as unknown as TaskDetail;
    const seen = new Set(['AR-3']);
    const view = visibleTaskDetail(client, detail, (key) => seen.has(key));
    expect(view.task.links).toEqual([pr, { kind: 'related', ref: 'AR-3' }]);
    expect(view.subtasks![0]!.links).toEqual([pr, { kind: 'related', ref: 'AR-3' }]);

    const event: ProjectEvent = { type: 'task_upserted', projectKey: 'AR', task: linked };
    const byKey = new Map(others.map((t) => [t.key, t]));
    const sent = visibleProjectEvent(client, event, (key) => byKey.get(key));
    expect(sent.type === 'task_upserted' && sent.task.links).toEqual([pr, { kind: 'related', ref: 'AR-3' }]);
    expect(visibleProjectEvent(developer, event, (key) => byKey.get(key))).toBe(event);
  });

  it('shows a client the theme of a card only when the theme is shared with them (PM-192)', () => {
    const themed = (key: string, themeKey: string) => ({ ...task(key, 'shared'), themeKey }) as Task;
    const cards = [
      task('AR-8', 'internal'),
      task('AR-9', 'shared'),
      themed('AR-1', 'AR-8'),
      themed('AR-2', 'AR-9'),
    ];
    const forClient = visibleTasks(client, cards);
    expect(forClient.find((t) => t.key === 'AR-1')).not.toHaveProperty('themeKey');
    expect(forClient.find((t) => t.key === 'AR-2')!.themeKey).toBe('AR-9');
    expect(visibleTasks(developer, cards).find((t) => t.key === 'AR-1')!.themeKey).toBe('AR-8');
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

  it('shows attachment events in a shared task of a client, and no other internal event', () => {
    const detail = {
      task: task('AR-1', 'shared'),
      parent: null,
      pullRequests: [],
      timeline: [
        'task_created',
        'attachment_added',
        'attachment_deleted',
        'task_note',
        'session_started',
      ].map((type) => timeline(type as TimelineEvent['type'])),
      sessions: [],
    } as unknown as TaskDetail;
    expect(visibleTaskDetail(client, detail).timeline).toEqual([
      timeline('task_created'),
      timeline('attachment_added'),
      timeline('attachment_deleted'),
    ]);
  });

  it('tells a client of a changed attachment list only while the task is shared with them', () => {
    const event = { type: 'task_attachments_changed', projectKey: 'AR', taskKey: 'AR-1' } as ProjectEvent;
    const tasks: Record<string, Task> = { 'AR-1': task('AR-1', 'shared') };
    const taskOf = (key: string) => tasks[key];
    expect(canSeeProjectEvent(client, event, taskOf)).toBe(true);
    expect(canSeeProjectEvent(developer, event, taskOf)).toBe(true);
    // Judged at delivery, with the task as it is then.
    tasks['AR-1'] = task('AR-1', 'internal');
    expect(canSeeProjectEvent(client, event, taskOf)).toBe(false);
    expect(canSeeProjectEvent(developer, event, taskOf)).toBe(true);
    // A task that cannot be found, or no way to look it up: not for a client.
    expect(canSeeProjectEvent(client, event, () => undefined)).toBe(false);
    expect(canSeeProjectEvent(client, event)).toBe(false);
  });
});
