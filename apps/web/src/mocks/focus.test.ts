import { describe, expect, it } from 'vitest';
import { ProjectFocusView, PROJECT_FOCUS_MAX_ITEMS, Task } from '@projectman/shared';
import { MockBackend } from './backend';

const base = '/api/projects/AC/focus';
const tasks = '/api/projects/AC/tasks';
const codeOf = (result: { body?: unknown }) => (result.body as { error: { code: string } }).error.code;
const view = (backend: MockBackend) => ProjectFocusView.parse(backend.handle('GET', base, undefined).body);
const keys = (backend: MockBackend) => view(backend).items.map((item) => item.key);
const add = (backend: MockBackend, key: string, position?: number) =>
  backend.handle('POST', `${base}/items`, position === undefined ? { key } : { key, position });
const changes = (backend: MockBackend) =>
  backend.handle('GET', `${base}/changes`, undefined, new URLSearchParams()).body as {
    events: { taskKey: string | null; data: Record<string, unknown> }[];
  };

describe('mock backend focus (the server contract of PM-435)', () => {
  it('starts empty, and the owner may change it', () => {
    const backend = new MockBackend();
    expect(view(backend)).toMatchObject({ items: [], canEdit: true });
  });

  it('adds at the end or at a place, clamps the place and refuses a repeat', () => {
    const backend = new MockBackend();
    expect(add(backend, 'AC-24').status).toBe(200);
    expect(add(backend, 'AC-23', 1).status).toBe(200);
    expect(add(backend, 'AC-22', 99).status).toBe(200);
    expect(keys(backend)).toEqual(['AC-23', 'AC-24', 'AC-22']);
    const repeat = add(backend, 'AC-24');
    expect([repeat.status, codeOf(repeat)]).toEqual([409, 'focus_item_exists']);
    expect(codeOf(add(backend, 'AC-999'))).toBe('not_found');
  });

  it('refuses a closed card and a full list', () => {
    const backend = new MockBackend();
    backend.handle('POST', `${tasks}/AC-24/cancel`, {});
    expect(codeOf(add(backend, 'AC-24'))).toBe('focus_task_closed');
    for (let index = 0; index < PROJECT_FOCUS_MAX_ITEMS; index += 1) {
      const task = Task.parse(backend.handle('POST', tasks, { title: `Card ${index}` }).body);
      expect(add(backend, task.key).status).toBe(200);
    }
    expect(codeOf(add(backend, 'AC-23'))).toBe('focus_full');
  });

  it('moves, removes, and refuses an unknown item', () => {
    const backend = new MockBackend();
    for (const key of ['AC-24', 'AC-23', 'AC-22']) add(backend, key);
    expect(backend.handle('PATCH', `${base}/items/AC-22`, { position: 1 }).status).toBe(200);
    expect(keys(backend)).toEqual(['AC-22', 'AC-24', 'AC-23']);
    expect(backend.handle('DELETE', `${base}/items/AC-24`, undefined).status).toBe(200);
    expect(keys(backend)).toEqual(['AC-22', 'AC-23']);
    const unknown = backend.handle('DELETE', `${base}/items/AC-24`, undefined);
    expect([unknown.status, codeOf(unknown)]).toEqual([404, 'focus_item_unknown']);
    expect(codeOf(backend.handle('PATCH', `${base}/items/AC-24`, { position: 1 }))).toBe(
      'focus_item_unknown',
    );
  });

  it('records the changes: an add and a remove on the card, a move on no card, newest first', () => {
    const backend = new MockBackend();
    add(backend, 'AC-24');
    add(backend, 'AC-23');
    backend.handle('PATCH', `${base}/items/AC-23`, { position: 1 });
    backend.handle('PATCH', `${base}/items/AC-23`, { position: 1 });
    backend.handle('DELETE', `${base}/items/AC-24`, undefined);
    const { events } = changes(backend);
    expect(
      events.map((event) => [event.data.action, event.taskKey, event.data.position, event.data.previous]),
    ).toEqual([
      ['removed', 'AC-24', null, 2],
      ['moved', null, 1, 2],
      ['added', 'AC-23', 2, null],
      ['added', 'AC-24', 1, null],
    ]);
  });

  it('tells the open pages about a change, not about a move to the same place', () => {
    const backend = new MockBackend();
    const seen: unknown[] = [];
    const connection = { deliver: (event: unknown) => seen.push(event) };
    backend.connect(connection);
    backend.handleCommand(connection, { type: 'subscribe_project', projectKey: 'AC' });
    add(backend, 'AC-24');
    backend.handle('PATCH', `${base}/items/AC-24`, { position: 1 });
    const focusEvents = seen.filter((event) => (event as { type: string }).type === 'project_focus_changed');
    expect(focusEvents).toHaveLength(1);
    expect(focusEvents[0]).toMatchObject({
      projectKey: 'AC',
      focus: { items: [{ key: 'AC-24' }] },
    });
  });

  // A client sees everything a member sees (PM-79), and sets nothing.
  it.each(['qa', 'kata'])('lets %s read the list and the changes but not change it', (handle) => {
    const backend = new MockBackend();
    add(backend, 'AC-24');
    backend.viewerHandle = handle;
    expect(view(backend)).toMatchObject({ canEdit: false, items: [{ key: 'AC-24' }] });
    expect(backend.handle('GET', `${base}/changes`, undefined, new URLSearchParams()).status).toBe(200);
    expect(codeOf(add(backend, 'AC-23'))).toBe('focus_not_allowed');
    expect(codeOf(backend.handle('DELETE', `${base}/items/AC-24`, undefined))).toBe('focus_not_allowed');
  });
});
