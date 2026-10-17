import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { routes, superActorOf } from '@projectman/shared';
import type { Actor } from '@projectman/shared';
import type { IntegratorExecutionContext } from '../src/contracts';
import { createAppHarness, createProject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

type Mode = 'own' | 'legacy' | 'super' | 'read';
describe('credential REST and domain access (PM-759)', () => {
  let h: AppHarness;
  let cookie: string;
  beforeEach(async () => {
    h = await createAppHarness();
    cookie = await setupOwner(h.app);
    await createProject(h, cookie);
  });
  afterEach(async () => h.close());

  async function credential(mode: Mode) {
    const { auth, repos } = h.app.projectman;
    const user = repos.users.list()[0]!;
    if (mode === 'own') return { headers: { cookie }, context: null };
    const created =
      mode === 'legacy'
        ? auth.createIntegratorKey(user.id, null)
        : auth.createIntegratorAccessKey(user.id, { mode, expiresInDays: 7 });
    const principal = auth.resolveIntegratorCredential(created.secret, 'rest')!;
    return {
      headers: { authorization: `Bearer ${created.secret}` },
      context: {
        principal,
        email: user.email,
        requestId: `req-${mode}`,
        projectKey: 'AR',
      } satisfies IntegratorExecutionContext,
    };
  }

  it.each(['own', 'legacy', 'super', 'read'] as const)('%s reads every administrative area', async (mode) => {
    const { headers } = await credential(mode);
    for (const url of [
      routes.config('AR'),
      routes.members('AR'),
      routes.invitations('AR'),
      routes.engineStatus(),
      routes.projectPause('AR'),
      routes.instancePause(),
      routes.tasks('AR'),
      routes.teamMessages('AR'),
      `${routes.mergeQueueOrder('AR')}?repo=web`,
      routes.operatorPreferences('AR'),
    ]) {
      const response = await h.app.inject({ url, headers });
      expect(response.statusCode, `${mode} ${url}: ${response.body}`).toBe(
        mode === 'legacy' && url === routes.operatorPreferences('AR') ? 403 : 200,
      );
    }
  });

  it.each(['own', 'legacy', 'super', 'read'] as const)(
    '%s writes through existing services with its own provenance',
    async (mode) => {
      const { headers } = await credential(mode);
      const { domain } = h.app.projectman;
      const cases = [
        {
          method: 'PATCH' as const,
          url: routes.config('AR'),
          payload: {
            baseVersion: (await domain.projects.load('AR')).version,
            project: { name: 'Updated project' },
          },
          legacy: true,
          status: 200,
        },
        {
          method: 'PATCH' as const,
          url: routes.member('AR', 'dev-1'),
          payload: { displayName: 'Updated developer' },
          legacy: false,
          status: 200,
        },
        {
          method: 'POST' as const,
          url: routes.addHumanMember('AR'),
          payload: { displayName: 'Guest seat', roles: [], access: 'viewer', handle: 'guest' },
          legacy: false,
          status: 201,
        },
        {
          method: 'POST' as const,
          url: routes.invitations('AR'),
          payload: { email: 'invited@example.invalid', roles: [], access: 'viewer' },
          legacy: false,
          status: 201,
        },
        {
          method: 'POST' as const,
          url: routes.tasks('AR'),
          payload: { title: 'Credential task', actor: { kind: 'human', handle: 'owner' } },
          legacy: true,
          status: 201,
        },
        {
          method: 'POST' as const,
          url: routes.projectPause('AR'),
          payload: { reason: 'Administrative pause' },
          legacy: true,
          status: 200,
        },
        {
          method: 'POST' as const,
          url: routes.projectPauseResume('AR'),
          payload: {},
          legacy: true,
          status: 200,
        },
        {
          method: 'POST' as const,
          url: routes.sendTeamMessage('AR'),
          payload: {
            to: ['dev-1'],
            text: 'Administrative note',
            kind: 'info',
            actor: { kind: 'human', handle: 'owner' },
          },
          legacy: true,
          status: 202,
        },
      ];
      for (const { legacy, status, ...endpoint } of cases) {
        const response = await h.app.inject({ ...endpoint, headers });
        const expected = mode === 'read' || (mode === 'legacy' && !legacy) ? 403 : status;
        expect(response.statusCode, `${mode} ${endpoint.url}: ${response.body}`).toBe(expected);
        if (mode === 'read') expect(response.json().error.code).toBe('integrator_read_only');
      }
      if (mode === 'super') {
        const task = domain.tasks.list('AR').find((t) => t.title === 'Credential task')!;
        const priority = await h.app.inject({
          method: 'PATCH',
          url: routes.task('AR', task.key),
          headers,
          payload: { priority: 'high' },
        });
        expect(priority.statusCode, priority.body).toBe(200);
        expect(
          h.app.projectman.repos.timeline
            .list('AR', { taskKey: task.key })
            .find((e) => e.type === 'task_created')?.actor,
        ).toMatchObject({ kind: 'ai', handle: 'operator', operatorMode: 'super' });
        const sent = h.app.projectman.repos.messages.list('AR').find((m) => m.body === 'Administrative note');
        expect(sent).toMatchObject({ from: 'operator', actor: { kind: 'ai', operatorMode: 'super' } });
      }
    },
  );

  it('allows super policy configuration but refuses approvals and actor forgery at domain entry', async () => {
    const { headers, context } = await credential('super');
    const { domain } = h.app.projectman;
    const loaded = await domain.projects.load('AR');
    const pipeline = structuredClone(loaded.config.pipeline);
    const label = pipeline.labels.find((entry) => entry.id === 'code-review-ok')!;
    label.requiresComment = true;
    const policy = await h.app.inject({
      method: 'PATCH',
      url: routes.config('AR'),
      headers,
      payload: { baseVersion: loaded.version, pipeline },
    });
    expect(policy.statusCode, policy.body).toBe(200);
    const task = await domain.tasks.create(
      'AR',
      { title: 'Approval target' },
      { kind: 'human', handle: 'owner' },
    );
    const actor = superActorOf(await domain.projects.config('AR'), {
      id: context!.principal.keyId,
      prefix: context!.principal.prefix,
    })!;
    for (const labelId of ['merge-ok', 'code-review-ok']) {
      const response = await h.app.inject({
        method: 'PATCH',
        url: routes.task('AR', task.key),
        headers,
        payload: { labels: [labelId], actor: { kind: 'human', handle: 'owner' } },
      });
      expect(response.statusCode, response.body).toBe(403);
      expect(response.json().error.code).toBe('owner_approval_required');
      await expect(
        domain.superOperator.run(context!, () =>
          domain.tasks.changeLabels('AR', task.key, { add: [labelId] }, actor, {
            comment: 'No human approval',
          }),
        ),
      ).rejects.toMatchObject({ code: 'owner_approval_required' });
    }
    await expect(
      domain.tasks.changeLabels('AR', task.key, { add: ['plain-tag'] }, actor),
    ).rejects.toMatchObject({ code: 'insufficient_access' });
    await expect(
      domain.superOperator.run(context!, () =>
        domain.tasks.create('AR', { title: 'Forged person' }, { kind: 'human', handle: 'owner' }),
      ),
    ).rejects.toMatchObject({ code: 'insufficient_access' });
    const approval = await h.app.inject({
      method: 'PATCH',
      url: routes.task('AR', task.key),
      headers: { cookie },
      payload: { labels: ['merge-ok'] },
    });
    expect(approval.statusCode, approval.body).toBe(200);
    expect(domain.tasks.get('AR', task.key).labels).toEqual(['merge-ok']);
    const waiver = await h.app.inject({
      method: 'PUT',
      url: routes.operatorApprovalWaiver('AR'),
      headers,
      payload: { enabled: true, baseVersion: policy.json().version, agreementVersion: 1 },
    });
    expect(waiver.statusCode).toBe(403);
    expect(waiver.json().error.code).toBe('owner_approval_required');
  });

  it('refuses every human decision at both REST and direct domain entry', async () => {
    const { context, headers } = await credential('super');
    const { domain } = h.app.projectman;
    for (const kind of ['decision', 'permission', 'approval', 'boundary', 'release'] as const) {
      const item = domain.inbox.create({
        projectKey: 'AR',
        kind,
        source: 'dev-1',
        sessionId: null,
        assignees: ['owner'],
        title: `Human ${kind}`,
        payload: {},
        options: [{ id: 'approve', label: 'Approve', style: 'primary' }],
      });
      const response = await h.app.inject({
        method: 'POST',
        url: routes.resolveInbox('AR', item.id),
        headers,
        payload: { optionId: 'approve' },
      });
      expect(response.statusCode, `${kind}: ${response.body}`).toBe(403);
      expect(response.json().error.code).toBe('owner_approval_required');
      await expect(
        domain.superOperator.run(context!, () =>
          domain.inbox.resolve('AR', item.id, { optionId: 'approve' }, { handle: 'owner', access: 'owner' }),
        ),
      ).rejects.toMatchObject({ code: 'owner_approval_required' });
      expect(domain.inbox.get('AR', item.id).state).toBe('open');
      if (kind === 'release')
        expect(() =>
          domain.superOperator.run(context!, () =>
            domain.releases.decide(item, { handle: 'owner', access: 'owner' }, 'approve', null),
          ),
        ).toThrow(expect.objectContaining({ code: 'owner_approval_required' }));
    }
    await expect(
      domain.superOperator.run(context!, () =>
        domain.boundary.decide('AR', 'bnd_unknown', 'owner', { decision: 'allow', reason: 'scope_verified' }),
      ),
    ).rejects.toMatchObject({ code: 'owner_approval_required' });
    await expect(
      domain.superOperator.run(context!, () =>
        domain.fixLimit.decide('operator', 'AR', 'AR-1', 'continue', 'No human decision'),
      ),
    ).rejects.toMatchObject({ code: 'owner_approval_required' });
  });

  it.each(['own', 'legacy', 'super', 'read'] as const)(
    '%s uses the engine administration policy',
    async (mode) => {
      const { headers } = await credential(mode);
      const app = await h.relaunch({ engineMode: 'cloud' });
      const response = await app.inject({
        method: 'POST',
        url: routes.engines(),
        headers,
        payload: { name: 'Test engine' },
      });
      expect(response.statusCode, response.body).toBe(mode === 'own' || mode === 'super' ? 201 : 403);
      if (mode === 'read') expect(response.json().error.code).toBe('integrator_read_only');
      if (response.statusCode === 201) {
        const id = response.json().engine.id as string;
        const defaulted = await app.inject({ method: 'POST', url: routes.defaultEngine(id), headers });
        expect(defaulted.statusCode, defaulted.body).toBe(200);
        const revoked = await app.inject({ method: 'POST', url: routes.revokeEngine(id), headers });
        expect(revoked.statusCode, revoked.body).toBe(mode === 'super' ? 403 : 200);
        if (mode === 'super') expect(revoked.json().error.code).toBe('owner_approval_required');
      }
    },
  );

  it('refuses read writes and decisions even when directly called with a human identity', async () => {
    const { context } = await credential('read');
    const { domain } = h.app.projectman;
    const actor: Actor = { kind: 'human', handle: 'owner' };
    await expect(
      domain.superOperator.run(context!, () => domain.tasks.create('AR', { title: 'Forbidden' }, actor)),
    ).rejects.toMatchObject({ code: 'integrator_read_only' });
    await expect(
      domain.superOperator.run(context!, () =>
        domain.messaging.send('AR', 'owner', { to: ['dev-1'], text: 'Forbidden' }),
      ),
    ).rejects.toMatchObject({ code: 'integrator_read_only' });
    await expect(
      domain.superOperator.run(context!, () =>
        domain.pauses.pause({ scope: 'project', projectKey: 'AR' }, { userId: null, source: 'app' }),
      ),
    ).rejects.toMatchObject({ code: 'integrator_read_only' });
  });

  it('uses one revision for permutations and prioritize and never edits a running merge or approval labels', async () => {
    const { domain, repos } = h.app.projectman;
    const { headers } = await credential('super');
    vi.spyOn(domain.merges, 'pump').mockImplementation(() => {});
    const tasks = await Promise.all(
      [1, 2, 3].map((i) =>
        domain.tasks.create('AR', { title: `Queued ${i}` }, { kind: 'human', handle: 'owner' }),
      ),
    );
    for (const [index, task] of tasks.entries())
      repos.taskMerges.save({
        id: `merge_${index}`,
        taskKey: task.key,
        projectKey: 'AR',
        repo: 'web',
        base: 'main',
        fromStageId: 'merge',
        toStageId: 'done',
        merger: 'owner',
        requestedAt: '2026-10-17T12:00:00.000Z',
        state: index === 2 ? 'running' : 'queued',
        landed: 'nowhere',
        createdAt: '2026-10-17T12:00:00.000Z',
        updatedAt: '2026-10-17T12:00:00.000Z',
      });
    const queue = repos.taskMerges.queueOrder('AR', 'web');
    const payload = {
      repo: 'web',
      expectedRevision: queue.revision,
      taskKeys: [...queue.taskKeys].reverse(),
      reason: 'New order',
    };
    const results = await Promise.all(
      [1, 2].map(() => h.app.inject({ method: 'PUT', url: routes.mergeQueueOrder('AR'), headers, payload })),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(repos.taskMerges.get('merge_2')?.state).toBe('running');
    for (const task of tasks) expect(domain.tasks.get('AR', task.key).labels).toEqual([]);
    const before = repos.taskMerges.queueOrder('AR', 'web');
    const priority = await h.app.inject({
      method: 'POST',
      url: routes.taskMergePrioritize('AR', tasks[0]!.key),
      headers,
      payload: { reason: 'Priority' },
    });
    expect(priority.statusCode, priority.body).toBe(200);
    expect(repos.taskMerges.queueOrder('AR', 'web')).toEqual({
      revision: before.revision + 1,
      taskKeys: queue.taskKeys,
    });
  });

  it('refuses reserved effects without configuration, task or invitation side effects', async () => {
    const { headers } = await credential('super');
    const { domain, repos } = h.app.projectman;
    const task = await domain.tasks.create(
      'AR',
      { title: 'Internal task' },
      { kind: 'human', handle: 'owner' },
    );
    const loaded = await domain.projects.load('AR');
    const removal = structuredClone(loaded.config);
    removal.team.members = removal.team.members.filter((m) => m.handle !== 'dev-1');
    const direction = structuredClone(loaded.config);
    direction.project.repos[0]!.defaultBranch = 'other';
    const before = {
      version: loaded.version,
      tasks: repos.tasks.list('AR').length,
      labels: domain.tasks.get('AR', task.key).labels,
    };
    for (const endpoint of [
      { method: 'PUT' as const, url: routes.config('AR'), payload: removal },
      {
        method: 'POST' as const,
        url: routes.tasks('AR'),
        payload: {
          title: 'Forged historical approval',
          importedAt: '2026-10-17T12:00:00.000Z',
          labels: ['merge-ok'],
          stageId: 'done',
        },
      },
      { method: 'PUT' as const, url: routes.config('AR'), payload: direction },
      {
        method: 'PATCH' as const,
        url: routes.member('AR', 'dev-1'),
        payload: { provider: 'nanogpt', model: 'paid-model' },
      },
      {
        method: 'POST' as const,
        url: routes.tasks('AR'),
        payload: { title: 'Forbidden publication', visibility: 'shared' },
      },
      {
        method: 'PATCH' as const,
        url: routes.task('AR', task.key),
        payload: { visibility: 'shared', title: 'Must stay unchanged' },
      },
    ]) {
      const response = await h.app.inject({ ...endpoint, headers });
      expect(response.statusCode, response.body).toBe(403);
      expect(response.json().error.code).toBe('owner_approval_required');
      expect((await domain.projects.load('AR')).version).toBe(before.version);
      expect(repos.tasks.list('AR')).toHaveLength(before.tasks);
      expect(domain.tasks.get('AR', task.key)).toMatchObject({
        title: 'Internal task',
        visibility: 'internal',
        labels: before.labels,
      });
    }
    const invite = await h.app.inject({
      method: 'POST',
      url: routes.invitations('AR'),
      headers,
      payload: { email: 'seat@example.invalid', access: 'viewer', roles: [] },
    });
    expect(invite.statusCode, invite.body).toBe(201);
    const revoke = await h.app.inject({
      method: 'DELETE',
      url: routes.invitation('AR', invite.json().id),
      headers,
    });
    expect(revoke.statusCode).toBe(403);
    expect(revoke.json().error.code).toBe('owner_approval_required');
    expect(domain.invitations.list('AR')[0]?.revokedAt).toBeNull();
  });

  it('rejects copied principals, mismatched actors and work inherited past the scope lifetime', async () => {
    const { context } = await credential('super');
    const { domain } = h.app.projectman;
    expect(Object.isFrozen(context!.principal)).toBe(true);
    await expect(
      domain.superOperator.run(context!, () => domain.machine.stopOrphans([], context!.principal.userId)),
    ).rejects.toMatchObject({ code: 'integrator_not_allowed' });
    expect(() =>
      domain.superOperator.run({ ...context!, principal: { ...context!.principal } }, () => true),
    ).toThrow(expect.objectContaining({ code: 'integrator_key_invalid' }));
    const actor = superActorOf(await domain.projects.config('AR'), {
      id: context!.principal.keyId,
      prefix: context!.principal.prefix,
    })!;
    for (const forged of [
      { kind: 'system', handle: null },
      { ...actor, credential: { id: 'wrong', prefix: 'pmi_wrong' } },
    ] as Actor[])
      await expect(
        domain.superOperator.run(context!, () =>
          domain.tasks.create('AR', { title: 'Forged actor' }, forged),
        ),
      ).rejects.toMatchObject({ code: 'insufficient_access' });
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    let delayed!: Promise<unknown>;
    const loaded = await domain.projects.load('AR');
    await expect(
      domain.superOperator.run(context!, () =>
        domain.projects.patch(
          'AR',
          { baseVersion: loaded.version, project: { name: 'Forged author' } },
          {
            actor,
            author: {
              name: 'Owner',
              email: context!.email,
              via: 'integrator',
              superActor: { ...actor, kind: 'human' } as unknown as typeof actor,
              authorizedBy: 'owner',
              superRequestId: context!.requestId,
            },
          },
        ),
      ),
    ).rejects.toMatchObject({ code: 'insufficient_access' });
    await domain.superOperator.run(context!, async () => {
      delayed = wait.then(() => domain.tasks.create('AR', { title: 'Expired scope' }, actor));
    });
    release();
    await expect(delayed).rejects.toMatchObject({ code: 'insufficient_access' });
  });

  it('rechecks revocation after an authorizer wait while retaining the configuration lock', async () => {
    const { headers, context } = await credential('super');
    const { domain, auth } = h.app.projectman;
    const loaded = await domain.projects.load('AR');
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached!: () => void;
    const entered = new Promise<void>((resolve) => {
      reached = resolve;
    });
    domain.superOperator.useMutationAuthorizer({
      async assertAllowed() {
        reached();
        await wait;
      },
    });
    const response = h.app
      .inject({
        method: 'PATCH',
        url: routes.config('AR'),
        headers,
        payload: { baseVersion: loaded.version, project: { name: 'Must not commit' } },
      })
      .then((result) => result);
    await entered;
    auth.revokeIntegratorAccessKey(context!.principal.userId, context!.principal.keyId);
    release();
    const refused = await response;
    expect(refused.statusCode, refused.body).toBe(401);
    expect(refused.json().error.code).toBe('integrator_key_invalid');
    expect((await domain.projects.load('AR')).version).toBe(loaded.version);
  });

  it('keeps simultaneous projects separate and requires current ownership in the target project', async () => {
    const workspace = join(h.home, 'other-project');
    mkdirSync(workspace);
    const created = await h.app.inject({
      method: 'POST',
      url: routes.projects(),
      headers: { cookie },
      payload: {
        key: 'BR',
        name: 'Other project',
        workspacePath: workspace,
        templateId: 'test',
        repos: [{ name: 'web', path: '.', github: 'acme/web' }],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const { context, headers } = await credential('super');
    const { domain } = h.app.projectman;
    const actor = superActorOf(await domain.projects.config('AR'), {
      id: context!.principal.keyId,
      prefix: context!.principal.prefix,
    })!;
    const results = await Promise.all(
      ['AR', 'BR'].map((projectKey) =>
        domain.superOperator.run({ ...context!, projectKey }, () =>
          domain.tasks.create(projectKey, { title: `Bound ${projectKey}` }, actor),
        ),
      ),
    );
    expect(results.map((task) => task.projectKey)).toEqual(['AR', 'BR']);
    await expect(
      domain.superOperator.run(context!, () => domain.tasks.create('BR', { title: 'Wrong project' }, actor)),
    ).rejects.toMatchObject({ code: 'insufficient_access' });
    await domain.projects.update(
      'BR',
      { actor: { kind: 'human', handle: 'owner' }, author: { name: 'Owner', email: 'owner@example.com' } },
      (draft) => {
        const owner = draft.team.members.find((m) => m.handle === 'owner')!;
        if (owner.kind === 'human') owner.access = 'admin';
        draft.team.members.push({
          kind: 'human',
          handle: 'other-owner',
          displayName: 'Other owner',
          access: 'owner',
          roles: [],
          email: 'other@example.invalid',
        });
        return 'Transfer project ownership';
      },
    );
    expect((await h.app.inject({ url: routes.config('AR'), headers })).statusCode).toBe(200);
    expect((await h.app.inject({ url: routes.config('BR'), headers })).statusCode).toBe(403);
    expect((await h.app.inject({ url: routes.config('BR'), headers: { cookie } })).statusCode).toBe(200);
  });
});
