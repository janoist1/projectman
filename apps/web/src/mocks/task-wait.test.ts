import { describe, expect, it } from 'vitest';
import { TaskDetail } from '@projectman/shared';
import { MockBackend } from './backend';

describe('mock task detail: why the card stands still (PM-460)', () => {
  it('passes the stored ready hold through the card and the shared wait rule', () => {
    const backend = new MockBackend();
    const task = { ...backend.tasks.find((task) => task.key === 'AC-20')!, key: 'AC-999', id: 'tsk_ready' };
    backend.tasks.push(task);
    task.stageId = 'ready';
    task.assignee = null;
    task.status = 'active';
    task.labels = [];
    task.links = [];
    task.readyHold = { reason: 'focus_order', since: '2026-10-18T10:00:00Z' };
    const detail = TaskDetail.parse(backend.taskDetail(task));
    expect(detail.task.readyHold).toEqual(task.readyHold);
    expect(detail.wait).toMatchObject({ reason: 'ready', hold: task.readyHold });
  });
  it('serves the wait of the shared rule to the team, a client included', () => {
    const backend = new MockBackend();
    const detail = TaskDetail.parse(backend.taskDetail(backend.findTask('AC-20')!));
    expect(detail.wait?.reason).toEqual(expect.any(String));
    expect(detail.wait?.since).toEqual(expect.any(String));

    backend.viewerHandle = 'kata';
    const asClient = TaskDetail.parse(backend.taskDetail(backend.findTask('AC-20')!));
    expect(asClient.wait).toEqual(detail.wait);
  });

  it('has no wait for a closed card', () => {
    const backend = new MockBackend();
    const closed = backend.tasks.find((task) => task.status === 'done');
    expect(closed).toBeDefined();
    const detail = TaskDetail.parse(backend.taskDetail(closed!));
    expect(detail).not.toHaveProperty('wait');
  });
});
