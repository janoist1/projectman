import { describe, expect, it } from 'vitest';
import { Task } from '@projectman/shared';
import { MockBackend } from './backend';

const base = '/api/projects/AC/tasks';
describe('mock subtask backend', () => {
  it('creates a subtask with attributed history on both tasks', () => {
    const backend = new MockBackend();
    const child = Task.parse(
      backend.handle('POST', base, { title: 'Example child', parentKey: 'AC-20' }).body,
    );
    expect(child.parentKey).toBe('AC-20');
    const events = backend.timeline.filter((event) => event.type.startsWith('task_subtask_'));
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.actor.handle === 'owner')).toBe(true);
  });
  it('refuses creation under a subtask', () => {
    const backend = new MockBackend();
    const child = Task.parse(
      backend.handle('POST', base, { title: 'Example child', parentKey: 'AC-20' }).body,
    );
    expect(backend.handle('POST', base, { title: 'Invalid', parentKey: child.key }).status).toBe(400);
  });
});
