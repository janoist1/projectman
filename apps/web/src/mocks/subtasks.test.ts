import { describe, expect, it } from 'vitest';
import { Task, TaskDetail } from '@projectman/shared';
import { MockBackend } from './backend';

const base = '/api/projects/AC/tasks';
describe('mock subtask backend', () => {
  it('creates, updates, detaches and reparents with attributed history on both tasks', () => {
    const backend = new MockBackend();
    const child = Task.parse(
      backend.handle('POST', base, { title: 'Example child', parentKey: 'AC-20' }).body,
    );
    expect(child.parentKey).toBe('AC-20');
    expect(backend.handle('PATCH', `${base}/${child.key}`, { title: 'Example renamed child' }).status).toBe(
      200,
    );
    expect(backend.findTask(child.key)?.parentKey).toBe('AC-20');
    expect(backend.handle('PATCH', `${base}/${child.key}`, { parentKey: 'AC-21' }).status).toBe(200);
    const detail = TaskDetail.parse(backend.handle('GET', `${base}/${child.key}`, undefined).body);
    expect(detail.parent?.key).toBe('AC-21');
    const parent = TaskDetail.parse(backend.handle('GET', `${base}/AC-21`, undefined).body);
    expect(parent.subtasks?.map((task) => task.key)).toEqual([child.key]);
    expect(backend.handle('PATCH', `${base}/${child.key}`, { parentKey: null }).status).toBe(200);
    expect(backend.findTask(child.key)?.parentKey).toBeNull();
    const events = backend.timeline.filter((event) => event.type.startsWith('task_subtask_'));
    expect(events).toHaveLength(8);
    expect(events.every((event) => event.actor.handle === 'owner')).toBe(true);
  });
  it('refuses every invalid parent without mutating fields', () => {
    const backend = new MockBackend();
    const child = Task.parse(
      backend.handle('POST', base, { title: 'Example child', parentKey: 'AC-20' }).body,
    );
    backend.tasks.push({ ...child, key: 'XY-1', id: 'tsk_foreign', projectKey: 'XY', parentKey: null });
    for (const [key, parentKey, code] of [
      ['AC-20', 'AC-20', 'subtask_self_parent'],
      ['AC-21', 'AC-999', 'subtask_parent_not_found'],
      ['AC-21', 'XY-1', 'subtask_parent_project'],
      ['AC-21', child.key, 'subtask_parent_is_subtask'],
      ['AC-20', 'AC-21', 'subtask_has_children'],
    ]) {
      const result = backend.handle('PATCH', `${base}/${key}`, { parentKey, title: 'Must not save' });
      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({ error: { code } });
      expect(backend.findTask(key!)?.title).not.toBe('Must not save');
    }
    expect(backend.handle('POST', base, { title: 'Invalid', parentKey: child.key }).status).toBe(400);
  });
});
