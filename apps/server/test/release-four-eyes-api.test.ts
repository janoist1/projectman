import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { routes } from '@projectman/shared';
import type { ConfigView, InboxItem, Task } from '@projectman/shared';
import { SYSTEM_ACTOR } from '../src/domain';
import { addHumanAndLogin, createAppHarness, createProject, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { OWNER_ACTOR } from './helpers/domain-harness';

/** Four eyes over HTTP (the domain rules themselves: duties.test.ts). */
describe('release four eyes through the API', () => {
  let h: AppHarness;
  let owner: string;
  let releaseOwner: string;
  beforeEach(async () => {
    h = await createAppHarness();
    owner = await setupOwner(h.app);
    await createProject(h, owner);
    // A second release approver: the holders of the release approval duty approve a release.
    releaseOwner = await addHumanAndLogin(h.app, {
      handle: 'release-owner',
      name: 'Release Owner',
      access: 'owner',
      roles: ['operator'],
    });
  });
  afterEach(async () => h.close());

  it('requires an independent human to approve the release of a PR author', async () => {
    const { domain, repos } = h.app.projectman;
    const view = (await inject(h.app, 'GET', routes.config('AR'), owner)).json<ConfigView>();
    const enabled = await inject(h.app, 'PATCH', routes.patchConfig('AR'), owner, {
      baseVersion: view.version,
      releaseFourEyes: true,
    });
    expect(enabled.statusCode, enabled.body).toBe(200);

    const task = await domain.tasks.create('AR', { title: 'Fictional release' }, OWNER_ACTOR);
    repos.tasks.update(task.id, { stageId: 'merge' });
    domain.tasks.addLink(
      'AR',
      task.key,
      { kind: 'pull_request', ref: '42', author: 'owner', state: 'merged' },
      OWNER_ACTOR,
    );
    await domain.tasks.changeLabels('AR', task.key, { add: ['pr-merged'] }, SYSTEM_ACTOR);

    const move = await inject(h.app, 'PATCH', routes.task('AR', task.key), owner, { stageId: 'release' });
    expect([move.statusCode, move.json().error.code]).toEqual([409, 'approval_requested']);
    const [item] = domain.inbox.list('AR', { state: 'open', taskKey: task.key });
    expect(item).toMatchObject({ kind: 'decision', assignees: ['release-owner'] });

    const denied = await inject(h.app, 'POST', routes.resolveInbox('AR', item!.id), owner, {
      optionId: 'approve',
    });
    expect([denied.statusCode, denied.json().error.code]).toEqual([403, 'release_four_eyes']);
    expect(domain.tasks.get('AR', task.key)).toMatchObject({ stageId: 'merge', status: 'waiting' });

    const approved = await inject(h.app, 'POST', routes.resolveInbox('AR', item!.id), releaseOwner, {
      optionId: 'approve',
    });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json<InboxItem>()).toMatchObject({
      state: 'resolved',
      resolution: { optionId: 'approve', by: 'release-owner' },
    });
    const releaser = { kind: 'human', handle: 'release-owner' };
    expect(domain.tasks.get('AR', task.key)).toMatchObject<Partial<Task>>({
      stageId: 'release',
      labels: expect.arrayContaining(['pr-merged', 'release-ok']),
    });
    expect(domain.timeline.list('AR').slice(-2)).toEqual([
      expect.objectContaining({
        type: 'task_labels_changed',
        actor: releaser,
        data: { added: ['release-ok'], removed: [], reason: 'approval' },
      }),
      expect.objectContaining({
        type: 'task_stage_changed',
        actor: releaser,
        data: { from: 'merge', to: 'release', approvedBy: ['release-owner'], inboxItemIds: [item!.id] },
      }),
    ]);
  });
});
