import { describe, expect, it } from 'vitest';
import { Task } from '@projectman/shared';
import { MockBackend } from './backend';

const base = '/api/projects/AC/tasks';
const create = (backend: MockBackend, title: string, extra: object = {}) =>
  Task.parse(backend.handle('POST', base, { title, ...extra }).body);
const patch = (backend: MockBackend, key: string, body: object) =>
  backend.handle('PATCH', `${base}/${key}`, body);
const codeOf = (result: { body?: unknown }) => (result.body as { error: { code: string } }).error.code;
const themeEvents = (backend: MockBackend, key: string) =>
  backend.timeline
    .filter((event) => event.taskKey === key && event.type === 'task_theme_changed')
    .map((event) => `${String(event.data.previous)} -> ${String(event.data.themeKey)}`);

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

  it('puts a card into a theme with the server rule and records it on the three timelines', () => {
    const backend = new MockBackend();
    const [one, two] = [create(backend, 'One', { kind: 'theme' }), create(backend, 'Two', { kind: 'theme' })];
    const card = create(backend, 'Card');
    expect(patch(backend, card.key, { themeKey: one.key }).status).toBe(200);
    expect(backend.findTask(card.key)!.themeKey).toBe(one.key);
    patch(backend, card.key, { themeKey: two.key });
    patch(backend, card.key, { themeKey: null });
    expect(themeEvents(backend, card.key)).toEqual([
      `null -> ${one.key}`,
      `${one.key} -> ${two.key}`,
      `${two.key} -> null`,
    ]);
    expect(themeEvents(backend, one.key)).toEqual([`null -> ${one.key}`, `${one.key} -> ${two.key}`]);
    expect(themeEvents(backend, two.key)).toEqual([`${one.key} -> ${two.key}`, `${two.key} -> null`]);
  });

  it('refuses a theme that is missing, no theme or closed, and a theme or subtask as the card', () => {
    const backend = new MockBackend();
    const theme = create(backend, 'Epic', { kind: 'theme' });
    const parent = create(backend, 'Parent');
    const child = create(backend, 'Child', { parentKey: parent.key });
    const card = create(backend, 'Card');
    expect(codeOf(patch(backend, card.key, { themeKey: 'AC-999' }))).toBe('theme_not_found');
    expect(codeOf(patch(backend, card.key, { themeKey: parent.key }))).toBe('theme_not_a_theme');
    expect(codeOf(patch(backend, child.key, { themeKey: theme.key }))).toBe('theme_on_subtask');
    expect(codeOf(patch(backend, theme.key, { themeKey: theme.key }))).toBe('theme_on_theme');
    backend.handle('POST', `${base}/${theme.key}/close-theme`, {});
    expect(codeOf(patch(backend, card.key, { themeKey: theme.key }))).toBe('theme_closed');
    expect(backend.findTask(card.key)!.themeKey).toBeUndefined();
  });

  it('shows a subtask the theme of its collecting card and loses a card’s own theme when it becomes one', () => {
    const backend = new MockBackend();
    const [one, two] = [create(backend, 'One', { kind: 'theme' }), create(backend, 'Two', { kind: 'theme' })];
    const parent = create(backend, 'Parent', { themeKey: one.key });
    const child = create(backend, 'Child', { parentKey: parent.key });
    expect(backend.findTask(child.key)!.themeKey).toBe(one.key);
    patch(backend, parent.key, { themeKey: two.key });
    expect(backend.findTask(child.key)!.themeKey).toBe(two.key);

    const other = create(backend, 'Other', { themeKey: one.key });
    patch(backend, other.key, { parentKey: parent.key });
    expect(backend.findTask(other.key)!.themeKey).toBe(two.key);
    expect(themeEvents(backend, other.key)).toEqual([`null -> ${one.key}`, `${one.key} -> null`]);
  });

  it('does not move, start, cancel or give an assignee to a theme, and closes and reopens it', () => {
    const backend = new MockBackend();
    const theme = create(backend, 'Epic', { kind: 'theme' });
    expect(codeOf(patch(backend, theme.key, { stageId: 'development' }))).toBe('task_is_theme');
    expect(codeOf(patch(backend, theme.key, { assignee: 'fe-1' }))).toBe('task_is_theme');
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

  it('keeps a theme out of subtasks, prerequisites and duplicates of cards, like the server', () => {
    const backend = new MockBackend();
    const theme = create(backend, 'Epic', { kind: 'theme' });
    const card = create(backend, 'Card');
    const relate = (key: string, add: object[]) => patch(backend, key, { relations: { add } });
    expect(codeOf(patch(backend, card.key, { parentKey: theme.key }))).toBe('subtask_theme');
    expect(codeOf(relate(theme.key, [{ kind: 'prerequisite', key: card.key }]))).toBe('relation_theme');
    expect(codeOf(relate(card.key, [{ kind: 'duplicate_of', key: theme.key }]))).toBe('relation_theme');
    expect(relate(card.key, [{ kind: 'related', key: theme.key }]).status).toBe(200);
  });
});
