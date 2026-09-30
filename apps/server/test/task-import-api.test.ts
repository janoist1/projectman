import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cookieOf, createAppHarness, createProject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

const importedAt = '2024-03-12T09:15:00.000Z';
describe('owner task import API', () => {
  let h: AppHarness;
  let owner: string;
  beforeEach(async () => {
    h = await createAppHarness();
    owner = await setupOwner(h.app);
    await createProject(h, owner);
  });
  afterEach(async () => {
    await h.close();
  });

  it('skips all gates in later and done stages, records original dates and has no delivery side effects', async () => {
    const { domain, repos } = h.app.projectman;
    const moved = vi.fn();
    domain.tasks.onStageChanged(moved);
    const start = vi.spyOn(h.runner, 'start');
    const createInbox = vi.spyOn(domain.inbox, 'create');
    const sendMessage = vi.spyOn(domain.messages, 'record');
    for (const stageId of ['code_review', 'release', 'done']) {
      const result = await h.app.inject({
        method: 'POST',
        url: '/api/projects/AR/tasks',
        headers: { cookie: owner },
        payload: { title: 'Fictional old ticket', stageId, importedAt },
      });
      expect(result.statusCode, result.body).toBe(201);
      const task = result.json();
      expect(task).toMatchObject({
        stageId,
        createdAt: importedAt,
        updatedAt: importedAt,
        status: stageId === 'done' ? 'done' : 'active',
        closedAt: stageId === 'done' ? importedAt : null,
      });
      expect(domain.timeline.list('AR', { taskKey: task.key })).toEqual([
        expect.objectContaining({
          type: 'task_created',
          createdAt: importedAt,
          data: { title: 'Fictional old ticket', imported: true },
        }),
      ]);
    }
    expect(moved).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(createInbox).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(repos.sessions.list('AR')).toEqual([]);
    expect(domain.inbox.list('AR')).toEqual([]);
    const normal = await h.app.inject({
      method: 'POST',
      url: '/api/projects/AR/tasks',
      headers: { cookie: owner },
      payload: { title: 'Fictional new ticket', stageId: 'done' },
    });
    expect(normal.json().error.code).toBe('gate_blocked');
  });

  it.each(['admin', 'developer', 'client', 'viewer'])('rejects imports by %s', async (access) => {
    const invite = await h.app.inject({
      method: 'POST',
      url: '/api/projects/AR/invites',
      headers: { cookie: owner },
      payload: { email: `${access}@acme.test`, access, roles: [] },
    });
    const accepted = await h.app.inject({
      method: 'POST',
      url: `${invite.json().path.replace('/invite/', '/api/invites/')}/accept`,
      payload: { name: 'Fictional colleague', password: 'fictional password' },
    });
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/projects/AR/tasks',
      headers: { cookie: cookieOf(accepted) },
      payload: { title: 'Fictional old ticket', stageId: 'done', importedAt },
    });
    expect(response.statusCode, response.body).toBe(403);
    expect(h.app.projectman.repos.tasks.list('AR')).toEqual([]);
  });

  it('validates import dates and rejects non-human actors in the domain', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/projects/AR/tasks',
      headers: { cookie: owner },
      payload: { title: 'Fictional ticket', importedAt: 'yesterday' },
    });
    expect(response.statusCode).toBe(400);
    await expect(
      h.app.projectman.domain.tasks.create(
        'AR',
        { title: 'Fictional ticket', importedAt },
        { kind: 'ai', handle: 'dev-1' },
      ),
    ).rejects.toMatchObject({ code: 'owner_only', status: 403 });
  });
});
