import { describe, expect, it } from 'vitest';
import { Task } from '@projectman/shared';
import { MockBackend } from './backend';

const base = '/api/projects/AC/tasks';
const create = (backend: MockBackend, title: string, extra: object = {}) =>
  Task.parse(backend.handle('POST', base, { title, ...extra }).body);
describe('mock backend relations (the server contract of PM-202)', () => {
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
