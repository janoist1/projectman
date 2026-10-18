import { describe, expect, it } from 'vitest';
import { TaskDetail } from '@projectman/shared';
import { MockBackend } from './backend';

const base = '/api/projects/AC/tasks';

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
    const detail = TaskDetail.parse(backend.handle('GET', `${base}/${task.key}`, undefined).body);
    expect(detail.task.readyHold).toEqual(task.readyHold);
    expect(detail.wait).toMatchObject({ reason: 'ready', hold: task.readyHold });
  });
  it('serves the wait of the shared rule to the team, and none to a client', () => {
    const backend = new MockBackend();
    const detail = TaskDetail.parse(backend.handle('GET', `${base}/AC-20`, undefined).body);
    expect(detail.wait?.reason).toEqual(expect.any(String));
    expect(detail.wait?.since).toEqual(expect.any(String));

    backend.viewerHandle = 'kata';
    const asClient = TaskDetail.parse(backend.handle('GET', `${base}/AC-18`, undefined).body);
    expect(asClient).not.toHaveProperty('wait');
  });

  it('has no wait for a closed card', () => {
    const backend = new MockBackend();
    const closed = backend.tasks.find((task) => task.status === 'done');
    expect(closed).toBeDefined();
    const detail = TaskDetail.parse(backend.handle('GET', `${base}/${closed!.key}`, undefined).body);
    expect(detail).not.toHaveProperty('wait');
  });
});
