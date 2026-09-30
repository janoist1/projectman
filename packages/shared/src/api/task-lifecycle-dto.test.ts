import { describe, expect, it } from 'vitest';
import { CancelTaskRequest, CreateTaskRequest, ReopenTaskRequest, UpdateTaskRequest } from './dto';
import { routes } from './routes';

describe('task lifecycle requests', () => {
  it('parses cancel, reopen and assignment bodies', () => {
    expect(CancelTaskRequest.parse({})).toEqual({});
    expect(CancelTaskRequest.parse({ reason: 'Scope changed' })).toEqual({ reason: 'Scope changed' });
    expect(ReopenTaskRequest.parse({})).toEqual({});
    expect(UpdateTaskRequest.parse({ assignee: null })).toEqual({ assignee: null });
    expect(UpdateTaskRequest.parse({ assignee: 'dev-2' })).toEqual({ assignee: 'dev-2' });
    expect(routes.cancelTask('AR', 'AR-1')).toBe('/api/projects/AR/tasks/AR-1/cancel');
    expect(routes.reopenTask('AR', 'AR-1')).toBe('/api/projects/AR/tasks/AR-1/reopen');
  });

  it('sets a parent on creation and clears it only on update', () => {
    expect(CreateTaskRequest.parse({ title: 'Child', parentKey: 'AR-1' }).parentKey).toBe('AR-1');
    expect(UpdateTaskRequest.parse({ parentKey: null })).toEqual({ parentKey: null });
    expect(CreateTaskRequest.safeParse({ title: 'Child', parentKey: null }).success).toBe(false);
  });
});
