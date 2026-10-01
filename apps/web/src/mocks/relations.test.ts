import { describe, expect, it } from 'vitest';
import { Task } from '@projectman/shared';
import { MockBackend } from './backend';

const base = '/api/projects/AC/tasks';
const create = (backend: MockBackend, title: string, extra: object = {}) =>
  Task.parse(backend.handle('POST', base, { title, ...extra }).body);
const patch = (backend: MockBackend, key: string, relations: object, extra: object = {}) =>
  backend.handle('PATCH', `${base}/${key}`, { relations, ...extra });
const types = (backend: MockBackend, key: string) =>
  backend.timeline
    .filter((event) => event.taskKey === key && event.type.startsWith('task_relation_'))
    .map((event) => `${event.type} ${String(event.data.kind)} ${String(event.data.ref)}`);

describe('mock backend relations (the server contract of PM-202)', () => {
  it('stores a relation on the card that set it and records it on both timelines', () => {
    const backend = new MockBackend();
    const [a, b, c] = [create(backend, 'A'), create(backend, 'B'), create(backend, 'C')];
    const result = patch(backend, a.key, {
      add: [
        { kind: 'prerequisite', key: b.key },
        { kind: 'related', key: c.key },
      ],
    });
    expect(result.status).toBe(200);
    expect(backend.findTask(a.key)!.links).toEqual([
      { kind: 'prerequisite', ref: b.key },
      { kind: 'related', ref: c.key },
    ]);
    expect(backend.findTask(b.key)!.links).toEqual([]);
    expect(types(backend, a.key)).toEqual([
      'task_relation_added prerequisite ' + b.key,
      'task_relation_added related ' + c.key,
    ]);
    expect(types(backend, b.key)).toEqual(['task_relation_added prerequisite_of ' + a.key]);
    expect(types(backend, c.key)).toEqual(['task_relation_added related ' + a.key]);
  });

  it('refuses what the shared rules refuse, with the server codes, and changes nothing', () => {
    const backend = new MockBackend();
    const [a, b] = [create(backend, 'A'), create(backend, 'B')];
    patch(backend, a.key, { add: [{ kind: 'prerequisite', key: b.key }] });
    const refused = (key: string, relations: object) => {
      const result = patch(backend, key, relations, { title: 'Must not save' });
      expect(backend.findTask(key)!.title).not.toBe('Must not save');
      return [result.status, (result.body as { error: { code: string } }).error.code];
    };
    expect(refused(b.key, { add: [{ kind: 'prerequisite', key: a.key }] })).toEqual([400, 'relation_cycle']);
    expect(refused(a.key, { add: [{ kind: 'related', key: a.key }] })).toEqual([400, 'relation_self']);
    expect(refused(a.key, { add: [{ kind: 'related', key: 'AC-999' }] })).toEqual([
      400,
      'relation_target_not_found',
    ]);
    expect(refused(a.key, { remove: [{ kind: 'related', key: b.key }] })).toEqual([
      400,
      'relation_not_found',
    ]);
  });

  it('removes the reverse of a relation and keeps a parent change on the subtask events', () => {
    const backend = new MockBackend();
    const [a, b] = [create(backend, 'A'), create(backend, 'B')];
    patch(backend, a.key, {
      add: [
        { kind: 'prerequisite', key: b.key },
        { kind: 'part_of', key: 'AC-20' },
      ],
    });
    expect(backend.findTask(a.key)!.parentKey).toBe('AC-20');
    expect(patch(backend, b.key, { remove: [{ kind: 'prerequisite_of', key: a.key }] }).status).toBe(200);
    expect(backend.findTask(a.key)!.links).toEqual([]);
    expect(types(backend, b.key)).toEqual([
      'task_relation_added prerequisite_of ' + a.key,
      'task_relation_removed prerequisite_of ' + a.key,
    ]);
    expect(
      backend.timeline.filter((e) => e.taskKey === 'AC-20' && e.type === 'task_subtask_added'),
    ).toHaveLength(1);
  });

  it('closes a card that has not started as a duplicate, pointing at the original, and refuses a started one to a developer', () => {
    const backend = new MockBackend();
    const [a, b] = [create(backend, 'A'), create(backend, 'B')];
    const result = patch(backend, a.key, { add: [{ kind: 'duplicate_of', key: b.key }] });
    expect(result.status).toBe(200);
    expect(backend.findTask(a.key)!.status).toBe('cancelled');
    const cancelled = backend.timeline.find((e) => e.taskKey === a.key && e.data.action === 'cancelled');
    expect(cancelled?.data).toMatchObject({ reason: `duplicate of ${b.key}`, duplicateOf: b.key });
    expect(types(backend, b.key)).toEqual(['task_relation_added duplicated_by ' + a.key]);
    // A duplicate of a duplicate points at the original instead.
    const c = create(backend, 'C');
    const chained = patch(backend, c.key, { add: [{ kind: 'duplicate_of', key: a.key }] });
    expect((chained.body as { error: { code: string } }).error.code).toBe('relation_duplicate_of_duplicate');
  });

  it('creates a card with relations, or not at all', () => {
    const backend = new MockBackend();
    const a = create(backend, 'A');
    const made = backend.handle('POST', base, {
      title: 'Next',
      relations: [{ kind: 'prerequisite', key: a.key }],
    });
    expect(made.status).toBe(201);
    expect(Task.parse(made.body).links).toEqual([{ kind: 'prerequisite', ref: a.key }]);
    const count = backend.tasks.length;
    const refused = backend.handle('POST', base, {
      title: 'Refused',
      relations: [{ kind: 'related', key: 'AC-999' }],
    });
    expect(refused.status).toBe(400);
    expect(backend.tasks).toHaveLength(count);
  });
});
