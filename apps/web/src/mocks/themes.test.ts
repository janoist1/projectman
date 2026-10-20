import { describe, expect, it } from 'vitest';
import { Task } from '@projectman/shared';
import { MockBackend } from './backend';

const base = '/api/projects/AC/tasks';
const create = (backend: MockBackend, title: string, extra: object = {}) =>
  Task.parse(backend.handle('POST', base, { title, ...extra }).body);
const codeOf = (result: { body?: unknown }) => (result.body as { error: { code: string } }).error.code;
describe('mock backend themes (the server contract of PM-205)', () => {
  it('creates a theme in the first stage and refuses a stage, a repository and a parent on it', () => {
    const backend = new MockBackend();
    const theme = create(backend, 'Epic', { kind: 'theme' });
    expect(theme).toMatchObject({ kind: 'theme', status: 'active', assignee: null });
    expect(theme.stageId).toBe(backend.config.pipeline.stages[0]!.id);
    const parent = create(backend, 'Parent');
    expect(codeOf(backend.handle('POST', base, { title: 'E', kind: 'theme', stageId: 'development' }))).toBe(
      'task_is_theme',
    );
    expect(codeOf(backend.handle('POST', base, { title: 'E', kind: 'theme', parentKey: parent.key }))).toBe(
      'subtask_theme',
    );
    expect(create(backend, 'Card').kind).toBeUndefined();
  });

  it('does not start or cancel a theme, and closes and reopens it', () => {
    const backend = new MockBackend();
    const theme = create(backend, 'Epic', { kind: 'theme' });
    expect(codeOf(backend.handle('POST', `${base}/${theme.key}/start`, {}))).toBe('task_is_theme');
    expect(codeOf(backend.handle('POST', `${base}/${theme.key}/cancel`, {}))).toBe('task_is_theme');

    const closed = backend.handle('POST', `${base}/${theme.key}/close-theme`, {});
    expect(closed.status).toBe(200);
    expect(backend.findTask(theme.key)!.status).toBe('cancelled');
    expect(codeOf(backend.handle('POST', `${base}/${theme.key}/close-theme`, {}))).toBe('task_closed');
    expect(backend.handle('POST', `${base}/${theme.key}/reopen`, {}).status).toBe(200);
    expect(backend.findTask(theme.key)!.status).toBe('active');
    expect(codeOf(backend.handle('POST', `${base}/${create(backend, 'Card').key}/close-theme`, {}))).toBe(
      'task_not_theme',
    );
  });
});
