import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  prepareOperatorConfigPatch,
  roleBundle,
  routes,
  superActorOf,
  SuperOperateResponse,
} from '@projectman/shared';
import type { Actor } from '@projectman/shared';
import type { IntegratorExecutionContext } from '../src/contracts';
import { createAppHarness, createProject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

type Mode = 'own' | 'super' | 'read';
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
    const created = auth.createIntegratorAccessKey(user.id, { mode, expiresInDays: 7 });
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

  async function queuedTasks(count: number, runningLast = false) {
    const { domain, repos } = h.app.projectman;
    vi.spyOn(domain.merges, 'pump').mockImplementation(() => {});
    const tasks = await Promise.all(
      Array.from({ length: count }, (_, i) =>
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
        state: runningLast && index === count - 1 ? 'running' : 'queued',
        landed: 'nowhere',
        createdAt: '2026-10-17T12:00:00.000Z',
        updatedAt: '2026-10-17T12:00:00.000Z',
      });
    return tasks;
  }

  it.each(['own', 'super', 'read'] as const)('%s reads every administrative area', async (mode) => {
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
      expect(response.statusCode, `${mode} ${url}: ${response.body}`).toBe(200);
    }
  });

  it('executes an owner decision through the common command path and offers it as a decision candidate', async () => {
    const { headers } = await credential('super');
    const { domain, repos } = h.app.projectman;
    await domain.projects.update(
      'AR',
      {
        actor: { kind: 'human', handle: 'owner' },
        author: { name: 'Owner', email: 'owner@example.com' },
      },
      (draft) => {
        draft.project.repos[0]!.docs = { decisions: 'docs/DECISIONS.md' };
        return 'Configure the decision log';
      },
    );
    const item = domain.inbox.create({
      projectKey: 'AR',
      kind: 'question',
      source: 'dev-1',
      assignees: ['owner'],
      title: 'Choose an approach',
      payload: { question: 'Which approach?', responsePurpose: 'owner_decision' },
      options: [{ id: 'answer', label: 'answer', style: 'primary' }],
    });
    const response = await h.app.inject({
      method: 'POST',
      url: routes.superOperations('AR'),
      headers,
      payload: {
        requestId: randomUUID(),
        command: {
          kind: 'inbox_resolve',
          itemId: item.id,
          request: { optionId: 'answer', note: 'Use the first approach.' },
        },
      },
    });
    expect(response.statusCode, response.body).toBe(202);
    expect(SuperOperateResponse.parse(response.json()).operation.state).toBe('succeeded');
    const resolved = domain.inbox.get('AR', item.id);
    expect(resolved.resolution).toMatchObject({
      by: 'owner',
      via: 'integrator',
      superDecision: true,
      actor: { kind: 'ai', handle: 'operator', operatorMode: 'super' },
    });
    expect(resolved.resolution?.ownerAnswerRelayed).toBeUndefined();
    expect(
      repos.timeline.list('AR').find((event) => event.type === 'question_answered')?.actor,
    ).toMatchObject({
      kind: 'ai',
      handle: 'operator',
      operatorMode: 'super',
    });
    expect(domain.decisionCandidates.list('AR', await domain.projects.config('AR')).candidates).toEqual([
      expect.objectContaining({ item_id: item.id, answered_by: 'owner', via_integrator: true }),
    ]);
  });

  it('executes a release approval with the Operator as the timeline actor', async () => {
    const { headers } = await credential('super');
    const { domain, repos } = h.app.projectman;
    const task = await domain.tasks.create(
      'AR',
      { kind: 'theme', title: 'Release' },
      { kind: 'human', handle: 'owner' },
    );
    const at = new Date().toISOString();
    repos.releases.insert(
      {
        id: 'rel_fixture',
        projectKey: 'AR',
        repo: 'web',
        taskKey: task.key,
        state: 'proposed',
        commit: 'a'.repeat(40),
        baseCommit: null,
        tasks: [],
        summary: 'A release',
        proposedBy: 'dev-1',
        proposedAt: at,
        decidedBy: null,
        decidedAt: null,
        deployStartedAt: null,
        previousCommit: null,
        liveAt: null,
        tag: null,
        url: null,
        publishedAt: null,
        failure: null,
        publishError: null,
      },
      at,
    );
    const item = domain.inbox.create({
      projectKey: 'AR',
      kind: 'release',
      taskKey: task.key,
      source: 'dev-1',
      assignees: ['owner'],
      title: 'Release approval',
      payload: {
        release: {
          releaseId: 'rel_fixture',
          commit: 'a'.repeat(40),
          baseCommit: null,
          tasks: [],
          summary: 'A release',
        },
      },
      options: [{ id: 'approve', label: 'approve', style: 'primary' }],
    });
    const response = await h.app.inject({
      method: 'POST',
      url: routes.superOperations('AR'),
      headers,
      payload: {
        requestId: randomUUID(),
        command: { kind: 'inbox_resolve', itemId: item.id, request: { optionId: 'approve' } },
      },
    });
    expect(response.statusCode, response.body).toBe(202);
    expect(response.json().operation, response.body).toMatchObject({ state: 'succeeded' });
    expect(repos.releases.get('rel_fixture')).toMatchObject({ state: 'approved', decidedBy: 'owner' });
    expect(domain.inbox.get('AR', item.id).resolution).toMatchObject({
      by: 'owner',
      superDecision: true,
      actor: { handle: 'operator', operatorMode: 'super' },
    });
    expect(
      repos.timeline.list('AR', { taskKey: task.key }).find((event) => event.type === 'release_changed')
        ?.actor,
    ).toMatchObject({ handle: 'operator', operatorMode: 'super' });
  });

  it('executes a hand-on approval and records the move as the Operator', async () => {
    const { headers } = await credential('super');
    const { domain, repos } = h.app.projectman;
    const task = await domain.tasks.create(
      'AR',
      { title: 'Move this card' },
      { kind: 'human', handle: 'owner' },
    );
    const item = domain.inbox.create({
      projectKey: 'AR',
      kind: 'hand_on',
      taskKey: task.key,
      source: 'dev-1',
      assignees: ['owner'],
      title: 'Move this card',
      payload: {
        handOn: {
          taskKey: task.key,
          fromStageId: 'backlog',
          toStageId: 'development',
          requestedBy: 'dev-1',
        },
      },
      options: [{ id: 'move', label: 'move', style: 'primary' }],
    });
    repos.taskHandOns.save({
      projectKey: 'AR',
      taskKey: task.key,
      fromStageId: 'backlog',
      toStageId: 'development',
      requestedBy: 'dev-1',
      mover: 'owner',
      requestedAt: item.createdAt,
      inboxItemId: item.id,
    });
    const response = await h.app.inject({
      method: 'POST',
      url: routes.superOperations('AR'),
      headers,
      payload: {
        requestId: randomUUID(),
        command: { kind: 'inbox_resolve', itemId: item.id, request: { optionId: 'move' } },
      },
    });
    expect(response.statusCode, response.body).toBe(202);
    expect(response.json().operation).toMatchObject({ state: 'succeeded' });
    expect(domain.tasks.get('AR', task.key).stageId).toBe('development');
    expect(domain.inbox.get('AR', item.id).resolution).toMatchObject({
      by: 'owner',
      superDecision: true,
      actor: { handle: 'operator', operatorMode: 'super' },
    });
    expect(
      repos.timeline.list('AR', { taskKey: task.key }).find((event) => event.type === 'task_stage_changed')
        ?.actor,
    ).toMatchObject({ handle: 'operator', operatorMode: 'super' });
  });

  it.each([
    { source: 'operator', payload: {} },
    { source: 'dev-1', payload: { superOperation: null } },
    { source: 'dev-1', payload: { operatorApproval: null } },
  ])('refuses an Operator decision on a protected item: $source $payload', async ({ source, payload }) => {
    const { headers } = await credential('super');
    const { domain } = h.app.projectman;
    const item = domain.inbox.create({
      projectKey: 'AR',
      kind: 'question',
      source,
      assignees: ['owner'],
      title: 'Protected question',
      payload: { question: 'May I proceed?', responsePurpose: 'owner_decision', ...payload },
      options: [{ id: 'answer', label: 'answer', style: 'primary' }],
    });
    const response = await h.app.inject({
      method: 'POST',
      url: routes.resolveInbox('AR', item.id),
      headers,
      payload: { optionId: 'answer', note: 'Proceed' },
    });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json().error.code).toBe('owner_approval_required');
    expect(domain.inbox.get('AR', item.id).state).toBe('open');
  });

  it('refuses the entire group when the Operator asked a pending member', async () => {
    const { headers } = await credential('super');
    const { domain, repos } = h.app.projectman;
    const items = ['dev-1', 'operator'].map((source) =>
      domain.inbox.create({
        projectKey: 'AR',
        kind: 'question',
        source,
        assignees: ['owner'],
        title: 'Related question',
        payload: { question: 'Which approach?', responsePurpose: 'owner_decision' },
        options: [{ id: 'answer', label: 'answer', style: 'primary' }],
      }),
    );
    repos.inbox.createGroup({
      projectKey: 'AR',
      primaryItemId: items[0]!.id,
      itemIds: items.map((item) => item.id),
      question: 'Which shared approach?',
      note: 'Same decision',
      by: 'pm',
      at: items[0]!.createdAt,
    });
    const response = await h.app.inject({
      method: 'POST',
      url: routes.resolveInbox('AR', items[0]!.id),
      headers,
      payload: { optionId: 'answer', note: 'Proceed' },
    });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json().error.code).toBe('owner_approval_required');
    expect(items.map((item) => domain.inbox.get('AR', item.id).state)).toEqual(['open', 'open']);
  });

  it('refuses an integrator-asked information question through the generic resolution endpoint', async () => {
    const { headers, context } = await credential('super');
    const { domain } = h.app.projectman;
    const actor = superActorOf(await domain.projects.config('AR'), {
      id: context!.principal.keyId,
      prefix: context!.principal.prefix,
    })!;
    const item = domain.inbox.create({
      projectKey: 'AR',
      kind: 'question',
      source: 'dev-1',
      assignees: ['owner'],
      title: 'External question',
      payload: {
        question: 'Which port?',
        responsePurpose: 'information',
        externalQuestion: {
          ownerUserId: context!.principal.userId,
          actor,
          requestId: randomUUID(),
        },
      },
      options: [{ id: 'answer', label: 'answer', style: 'primary' }],
    });
    const response = await h.app.inject({
      method: 'POST',
      url: routes.resolveInbox('AR', item.id),
      headers,
      payload: { optionId: 'answer', note: '4700' },
    });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json().error.code).toBe('owner_approval_required');
    expect(domain.inbox.get('AR', item.id).state).toBe('open');
  });

  it('refuses an Operator proposal for a routine project pause', async () => {
    const { headers } = await credential('super');
    const { domain } = h.app.projectman;
    const item = domain.inbox.create({
      projectKey: 'AR',
      kind: 'approval',
      source: 'system',
      assignees: ['owner'],
      title: 'A routine proposal',
      payload: {
        operator: {
          requestId: 'opr_fixture',
          stepId: 'ops_fixture',
          quote: 'Pause the team',
          action: 'project_pause',
          operation: { op: 'project_pause' },
          changes: [],
          consequence: 'project_pause',
          baseVersion: null,
          session: null,
          stale: null,
        },
      },
      options: [{ id: 'approve', label: 'approve', style: 'primary' }],
    });
    const response = await h.app.inject({
      method: 'POST',
      url: routes.resolveInbox('AR', item.id),
      headers,
      payload: { optionId: 'approve' },
    });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json().error.code).toBe('owner_approval_required');
    expect(domain.inbox.get('AR', item.id).state).toBe('open');
  });

  it.each(['own', 'super', 'read'] as const)('%s retains its inbox approval policy', async (mode) => {
    const { headers } = await credential(mode);
    const item = h.app.projectman.domain.inbox.create({
      projectKey: 'AR',
      kind: 'decision',
      source: 'dev-1',
      assignees: ['owner'],
      title: 'A decision',
      payload: {},
      options: [{ id: 'approve', label: 'approve', style: 'primary' }],
    });
    const response = await h.app.inject({
      method: 'POST',
      url: routes.resolveInbox('AR', item.id),
      headers,
      payload: { optionId: 'approve' },
    });
    expect(response.statusCode, response.body).toBe(mode === 'own' || mode === 'super' ? 200 : 403);
    if (mode === 'super') expect(response.json().resolution).toMatchObject({ superDecision: true });
    if (mode === 'read')
      expect(response.json().error.code).toBe(
        mode === 'read' ? 'integrator_read_only' : 'owner_approval_required',
      );
  });

  it.each(['own', 'super', 'read'] as const)(
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
          status: 200,
        },
        {
          method: 'PATCH' as const,
          url: routes.member('AR', 'dev-1'),
          payload: { displayName: 'Updated developer' },
          status: 200,
        },
        {
          method: 'POST' as const,
          url: routes.addHumanMember('AR'),
          payload: { displayName: 'Guest seat', roles: [], access: 'viewer', handle: 'guest' },
          status: 201,
        },
        {
          method: 'POST' as const,
          url: routes.invitations('AR'),
          payload: { email: 'invited@example.invalid', roles: [], access: 'viewer' },
          status: 201,
        },
        {
          method: 'POST' as const,
          url: routes.tasks('AR'),
          payload: { title: 'Credential task', actor: { kind: 'human', handle: 'owner' } },
          status: 201,
        },
        {
          method: 'POST' as const,
          url: routes.projectPause('AR'),
          payload: { reason: 'Administrative pause' },
          status: 200,
        },
        {
          method: 'POST' as const,
          url: routes.projectPauseResume('AR'),
          payload: {},
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
          status: 202,
        },
      ];
      for (const { status, ...endpoint } of cases) {
        const response = await h.app.inject({ ...endpoint, headers });
        const expected = mode === 'read' ? 403 : status;
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

  it.each(['own', 'super', 'read'] as const)(
    '%s applies targeted Operator role and watch configuration through the existing PATCH',
    async (mode) => {
      const { domain } = h.app.projectman;
      const initial = await domain.projects.load('AR');
      const architect = { ...roleBundle(initial.config, 'architect'), instructions: 'Keep this role' };
      const seed = await h.app.inject({
        method: 'PATCH',
        url: routes.config('AR'),
        headers: { cookie },
        payload: { baseVersion: initial.version, roleOverrides: { architect } },
      });
      expect(seed.statusCode, seed.body).toBe(200);
      const before = await domain.projects.load('AR');
      const developer = { ...roleBundle(before.config, 'developer'), instructions: 'Updated role' };
      const { headers } = await credential(mode);
      const response = await h.app.inject({
        method: 'PATCH',
        url: routes.config('AR'),
        headers,
        payload: prepareOperatorConfigPatch(before.config, before.version, {
          operatorWatch: 'drive',
          roleOverrides: { developer },
        }),
      });
      const allowed = mode === 'own' || mode === 'super';
      expect(response.statusCode, response.body).toBe(allowed ? 200 : 403);
      const after = await domain.projects.load('AR');
      expect(after.config.team.roleOverrides?.architect).toEqual(architect);
      if (allowed) {
        expect(after.config.team.roleOverrides?.developer).toEqual(developer);
        expect(after.config.team.operatorWatch).toBe('drive');
      } else {
        expect(after).toEqual(before);
        if (mode === 'read') expect(response.json().error.code).toBe('integrator_read_only');
      }
    },
  );

  it.each(['own', 'super', 'read', 'super-command'] as const)(
    '%s orders the repository merge queue',
    async (mode) => {
      const { repos } = h.app.projectman;
      await queuedTasks(2);
      const before = repos.taskMerges.queueOrder('AR', 'web');
      const { headers } = await credential(mode === 'super-command' ? 'super' : mode);
      const taskKeys = [...before.taskKeys].reverse();
      const order = { repo: 'web', expectedRevision: before.revision, taskKeys, reason: 'Credential order' };
      const response = await h.app.inject({
        method: mode === 'super-command' ? 'POST' : 'PUT',
        url: mode === 'super-command' ? routes.superOperations('AR') : routes.mergeQueueOrder('AR'),
        headers,
        payload:
          mode === 'super-command'
            ? { requestId: randomUUID(), command: { kind: 'merge_order', ...order } }
            : order,
      });
      expect(response.statusCode, response.body).toBe(
        mode === 'read' ? 403 : mode === 'super-command' ? 202 : 200,
      );
      if (mode === 'read') {
        expect(response.json().error.code).toBe('integrator_read_only');
        expect(repos.taskMerges.queueOrder('AR', 'web')).toEqual(before);
      } else {
        if (mode === 'super-command') {
          expect(SuperOperateResponse.parse(response.json()).operation.state).toBe('succeeded');
          const events = h.app.projectman.domain.timeline
            .list('AR')
            .filter((event) => event.type === 'task_merge_prioritized');
          expect(events).not.toHaveLength(0);
          for (const event of events)
            expect(event.actor).toMatchObject({ kind: 'ai', handle: 'operator', operatorMode: 'super' });
        } else expect(response.json()).toEqual({ revision: before.revision + 1, taskKeys });
        expect(repos.taskMerges.queueOrder('AR', 'web')).toEqual({ revision: before.revision + 1, taskKeys });
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
    // An approval label the key owner holds is the Operator's own in super mode (PM-870); one the owner
    // does not hold stays refused.
    const refused = await h.app.inject({
      method: 'PATCH',
      url: routes.task('AR', task.key),
      headers,
      payload: { labels: ['code-review-ok'], actor: { kind: 'human', handle: 'owner' } },
    });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json().error.code).toBe('owner_approval_required');
    await expect(
      domain.superOperator.run(context!, () =>
        domain.tasks.changeLabels('AR', task.key, { add: ['code-review-ok'] }, actor, {
          comment: 'No human approval',
        }),
      ),
    ).rejects.toMatchObject({ code: 'owner_approval_required' });
    const approved = await h.app.inject({
      method: 'PATCH',
      url: routes.task('AR', task.key),
      headers,
      payload: { labels: ['merge-ok'], actor: { kind: 'human', handle: 'owner' } },
    });
    expect(approved.statusCode, approved.body).toBe(200);
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

  it('keeps permission decisions exclusive to a person at REST and domain entry', async () => {
    const { context, headers } = await credential('super');
    const { domain } = h.app.projectman;
    for (const kind of ['permission'] as const) {
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
    }
    await expect(
      domain.superOperator.run(context!, () =>
        domain.inbox.resolveDelegated('AR', 'missing', 'operator', { decision: 'allow', reason: 'Checked' }),
      ),
    ).rejects.toMatchObject({ code: 'owner_approval_required' });
  });

  it.each(['own', 'super', 'read'] as const)('%s uses the engine administration policy', async (mode) => {
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
      expect(revoked.statusCode, revoked.body).toBe(200);
    }
  });

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
    const tasks = await queuedTasks(3, true);
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

  it('records only moved queue cards and the cards they actually overtake', async () => {
    const { domain, repos } = h.app.projectman;
    const tasks = await queuedTasks(5);
    const before = repos.taskMerges.queueOrder('AR', 'web');
    const [first, second, third, fourth, fifth] = before.taskKeys as [string, string, string, string, string];
    await domain.merges.orderQueue(
      'AR',
      { kind: 'human', handle: 'owner' },
      {
        repo: 'web',
        expectedRevision: before.revision,
        taskKeys: [first, fourth, third, second, fifth],
        reason: 'Move the dependency earlier',
      },
    );
    for (const task of tasks) {
      const events = repos.timeline
        .list('AR', { taskKey: task.key })
        .filter((event) => event.type === 'task_merge_prioritized');
      if (task.key === second || task.key === fourth) {
        expect(events).toHaveLength(1);
        expect(events[0]!.data).toMatchObject({
          reason: 'Move the dependency earlier',
          ahead: task.key === fourth ? [second, third] : [],
        });
      } else expect(events).toHaveLength(0);
    }
  });

  it('retries prioritize and complete reorder while the slot holder is still durably queued', async () => {
    const { domain, repos } = h.app.projectman;
    const tasks = await queuedTasks(2);
    const before = repos.taskMerges.queueOrder('AR', 'web');
    vi.spyOn(domain.merges, 'holder').mockReturnValue(tasks[0]!.key);
    await expect(
      domain.merges.prioritize('AR', tasks[1]!.key, { kind: 'human', handle: 'owner' }, 'Move earlier'),
    ).rejects.toMatchObject({ code: 'merge_queue_conflict' });
    await expect(
      domain.merges.orderQueue(
        'AR',
        { kind: 'human', handle: 'owner' },
        {
          repo: 'web',
          expectedRevision: before.revision,
          taskKeys: [...before.taskKeys].reverse(),
          reason: 'Move earlier',
        },
      ),
    ).rejects.toMatchObject({ code: 'merge_queue_conflict' });
    expect(repos.taskMerges.queueOrder('AR', 'web')).toEqual(before);
    for (const task of tasks)
      expect(
        repos.timeline
          .list('AR', { taskKey: task.key })
          .filter((event) => event.type === 'task_merge_prioritized'),
      ).toHaveLength(0);
  });

  it('records super hand-on decisions and cancels stale requests on a different administrative move', async () => {
    const { domain, repos } = h.app.projectman;
    const { context, headers } = await credential('super');
    for (const target of ['development', 'code_review']) {
      const task = await domain.tasks.create(
        'AR',
        { title: `Human hand-on ${target}` },
        { kind: 'human', handle: 'owner' },
      );
      const item = domain.inbox.create({
        projectKey: 'AR',
        taskKey: task.key,
        kind: 'hand_on',
        source: 'dev-1',
        sessionId: null,
        assignees: ['owner'],
        title: 'Human hand-on',
        payload: {
          handOn: {
            taskKey: task.key,
            fromStageId: 'backlog',
            toStageId: 'development',
            requestedBy: 'dev-1',
          },
        },
        options: [{ id: 'move', label: 'Move', style: 'primary' }],
      });
      const request = {
        projectKey: 'AR',
        taskKey: task.key,
        fromStageId: 'backlog',
        toStageId: 'development',
        mover: 'owner',
        requestedBy: 'dev-1',
        requestedAt: item.createdAt,
        inboxItemId: item.id,
      };
      repos.taskHandOns.save(request);
      const response = await h.app.inject({
        method: 'PATCH',
        url: routes.task('AR', task.key),
        headers,
        payload: { stageId: target },
      });
      if (target === 'development') {
        expect(response.statusCode, response.body).toBe(200);
        expect(domain.tasks.get('AR', task.key).stageId).toBe(target);
        expect(repos.inbox.get(item.id)).toMatchObject({
          state: 'resolved',
          resolution: {
            by: 'owner',
            superDecision: true,
            actor: { handle: 'operator' },
          },
        });
      } else {
        expect(response.statusCode, response.body).toBe(200);
        expect(domain.tasks.get('AR', task.key).stageId).toBe(target);
        expect(repos.inbox.get(item.id)).toMatchObject({ state: 'cancelled', resolution: null });
        expect(repos.taskHandOns.get('AR', task.key)).toBeNull();
      }
    }
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
      {
        method: 'PATCH' as const,
        url: routes.member('AR', 'dev-1'),
        payload: { provider: 'nanogpt', model: 'paid-model' },
      },
    ]) {
      const response = await h.app.inject({ ...endpoint, headers });
      expect(response.statusCode, response.body).toBe(403);
      expect(response.json().error.code).toBe('owner_approval_required');
      expect((await domain.projects.load('AR')).version).toBe(before.version);
      expect(repos.tasks.list('AR')).toHaveLength(before.tasks);
      expect(domain.tasks.get('AR', task.key)).toMatchObject({
        title: 'Internal task',
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
    // Direction and revoking an invitation are the Operator's own since PM-870.
    expect(revoke.statusCode, revoke.body).toBe(204);
    expect(domain.invitations.list('AR')[0]?.revokedAt).not.toBeNull();
    const relocation = await h.app.inject({
      method: 'PUT',
      url: routes.config('AR'),
      headers,
      payload: direction,
    });
    expect(relocation.statusCode, relocation.body).toBe(200);
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
