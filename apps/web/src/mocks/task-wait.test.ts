import { describe, expect, it } from 'vitest';
import { TaskDetail } from '@projectman/shared';
import { MockBackend } from './backend';

const base = '/api/projects/AC/tasks';

describe('mock task detail: why the card stands still (PM-460)', () => {
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
