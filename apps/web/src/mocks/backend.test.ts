import { describe, expect, it } from 'vitest';
import {
  ProjectChecklistView,
  ProvidersView,
  RETIRED_OPERATOR_HANDLE,
  validateProjectConfig,
} from '@projectman/shared';
import { MockBackend } from './backend';

const role = {
  id: 'data_steward',
  name: 'Acme steward',
  summary: 'Keeps reference data clean.',
  notTheirJob: 'Does not change schemas.',
  holders: 'both',
  instructions: 'Check reference records.',
};
const base = '/api/projects/AC';

it('serves checklist state changes and computes conditions and progress in the fake', () => {
  const backend = new MockBackend();
  backend.checklist = {
    baseTemplateId: null,
    items: [
      {
        id: 'agreement',
        title: 'Agreement',
        hint: null,
        source: 'base',
        templateId: null,
        condition: 'agreement_approved',
        conditionHolds: null,
        state: 'done',
        reason: null,
        reopened: null,
        updatedAt: new Date().toISOString(),
        updatedBy: 'system',
      },
    ],
    progress: { settled: 1, total: 1, complete: true },
  };
  const url = `${base}/checklist/items/agreement/state`;
  expect(backend.handle('POST', url, { state: 'not_needed' }).status).toBe(400);
  const response = backend.handle('POST', url, { state: 'open' });
  expect(response.status).toBe(200);
  const view = ProjectChecklistView.parse(response.body);
  expect(view.checklist?.items[0]).toMatchObject({ state: 'open', reopened: 'owner', conditionHolds: false });
  expect(view.checklist?.progress).toEqual({ settled: 0, total: 1, complete: false });
});

describe('integrator credential policy in the fake (PM-759)', () => {
  it('records a super inbox decision with the principal and the holder behind it', () => {
    const backend = new MockBackend();
    backend.integratorMode = 'super';
    const item = {
      ...backend.inbox[0]!,
      id: 'super_decision',
      kind: 'decision' as const,
      source: 'dev',
      sessionId: null,
      state: 'open' as const,
      assignees: [backend.viewerHandle],
      payload: {},
      resolution: null,
      options: [{ id: 'approve', label: 'approve', style: 'primary' as const }],
    };
    backend.inbox.push(item);
    const response = backend.handle('POST', `${base}/inbox/${item.id}/resolve`, { optionId: 'approve' });
    expect(response.status).toBe(200);
    expect(backend.inbox.find((row) => row.id === item.id)?.resolution).toMatchObject({
      by: backend.viewerHandle,
      via: 'integrator',
      superDecision: true,
      actor: { kind: 'human', handle: backend.viewerHandle, through: { holder: backend.viewerHandle } },
    });
  });

  it('uses the shared rule to refuse a question of the integrator’s own handle', () => {
    const backend = new MockBackend();
    backend.integratorMode = 'super';
    const item = {
      ...backend.inbox[0]!,
      id: 'own_question',
      kind: 'question' as const,
      source: RETIRED_OPERATOR_HANDLE,
      sessionId: null,
      state: 'open' as const,
      assignees: [backend.viewerHandle],
      payload: {},
      resolution: null,
      options: [{ id: 'answer', label: 'answer', style: 'primary' as const }],
    };
    backend.inbox.push(item);
    const response = backend.handle('POST', `${base}/inbox/${item.id}/resolve`, {
      optionId: 'answer',
      note: 'Yes',
    });
    expect(errorCode(response)).toBe('owner_approval_required');
    expect(backend.inbox.find((row) => row.id === item.id)?.state).toBe('open');
  });

  it('uses shared read rules and leaves publication to the super key (PM-870)', () => {
    const backend = new MockBackend();
    backend.integratorMode = 'read';
    expect(backend.handle('GET', `${base}/members`, undefined).status).toBe(200);
    const refused = backend.handle('POST', `${base}/tasks`, { title: 'Read cannot write' });
    expect(refused.status).toBe(403);
    expect(errorCode(refused)).toBe('integrator_read_only');
    backend.integratorMode = 'super';
    const publication = backend.handle('POST', `${base}/tasks`, {
      title: 'Shared by the Operator',
    });
    expect(publication.status).toBe(201);
    const imported = backend.handle('POST', `${base}/tasks`, {
      title: 'Historical human attribution',
      importedAt: '2026-10-17T12:00:00.000Z',
    });
    expect(imported.status).toBe(403);
    expect(errorCode(imported)).toBe('owner_approval_required');
  });

  it('uses one revision for queue permutations and stale updates', () => {
    const backend = new MockBackend();
    const repo = backend.config.project.repos[0]!.name;
    const cards = backend.tasks.slice(0, 2);
    for (const task of cards)
      task.merge = {
        id: `merge_${task.key}`,
        repo,
        base: 'main',
        merger: backend.viewerHandle,
        requestedAt: '2026-10-17T12:00:00.000Z',
        toStageId: 'done',
        state: 'queued',
        landed: 'nowhere',
      };
    const before = backend.handle(
      'GET',
      `${base}/merge-queue/order`,
      undefined,
      new URLSearchParams({ repo }),
    );
    const order = before.body as { revision: number; taskKeys: string[] };
    const body = {
      repo,
      expectedRevision: order.revision,
      taskKeys: [...order.taskKeys].reverse(),
      reason: 'Queue order',
    };
    const ordered = backend.handle('PUT', `${base}/merge-queue/order`, body);
    expect(ordered.status).toBe(200);
    expect(ordered.body).toEqual({ revision: order.revision + 1, taskKeys: body.taskKeys });
    expect(backend.handle('PUT', `${base}/merge-queue/order`, body).status).toBe(409);
  });
});
function errorCode(response: { body?: unknown }) {
  return (response.body as { error: { code: string } }).error.code;
}

describe('mock merger setting', () => {
  it('stores the merger and the per-repository merge setting like the server', () => {
    const backend = new MockBackend();
    const repo = backend.config.project.repos[0]!;
    const saved = backend.handle('PATCH', `${base}/config`, {
      baseVersion: backend.configVersion,
      merger: { kind: 'developer' },
      repoMerge: [{ repo: repo.name, requireMerge: false }],
    });
    expect(saved.status).toBe(200);
    expect(backend.config.team.merger).toEqual({ kind: 'developer' });
    expect(backend.config.project.repos[0]?.requireMerge).toBe(false);
  });

  it('refuses a repository the project does not have', () => {
    const backend = new MockBackend();
    const refused = backend.handle('PATCH', `${base}/config`, {
      baseVersion: backend.configVersion,
      repoMerge: [{ repo: 'no-such-repo', requireMerge: true }],
    });
    expect(refused.status).toBe(400);
    expect(errorCode(refused)).toBe('unknown_repo');
  });

  it('stores and clears the project documents of a repository, and refuses an unknown repository', () => {
    const backend = new MockBackend();
    const repo = backend.config.project.repos[0]!;
    const patch = (repoDocs: unknown) =>
      backend.handle('PATCH', `${base}/config`, { baseVersion: backend.configVersion, repoDocs });
    expect(patch([{ repo: repo.name, docs: { decisions: 'docs/D.md' } }]).status).toBe(200);
    expect(backend.config.project.repos[0]?.docs).toEqual({ decisions: 'docs/D.md' });
    expect(errorCode(patch([{ repo: 'no-such-repo', docs: null }]))).toBe('unknown_repo');
    expect(patch([{ repo: repo.name, docs: null }]).status).toBe(200);
    expect(backend.config.project.repos[0]).not.toHaveProperty('docs');
  });
});

describe('mock configuration error tolerance', () => {
  it('saves unrelated edits with existing errors and reports only additional errors', () => {
    const backend = new MockBackend();
    const column = backend.config.pipeline.columns[0]!;
    backend.config.pipeline.columns.push({ ...column, name: 'Duplicate' });
    const saved = backend.handle('PATCH', `${base}/config`, {
      baseVersion: backend.configVersion,
      limits: { maxConcurrentAi: 2 },
    });
    expect(saved.status).toBe(200);
    expect(backend.config.team.limits.maxConcurrentAi).toBe(2);
    const pipeline = structuredClone(backend.config.pipeline);
    pipeline.columns.push({ ...column, name: 'Third copy' });
    const refused = backend.handle('PATCH', `${base}/config`, {
      baseVersion: backend.configVersion,
      pipeline,
    });
    expect(refused).toMatchObject({
      status: 400,
      body: {
        error: {
          code: 'config_invalid',
          details: {
            issues: [
              {
                code: 'duplicate_column',
                path: `pipeline.columns[${pipeline.columns.length - 1}].id`,
                detail: column.id,
              },
            ],
          },
        },
      },
    });
    expect(backend.config.pipeline.columns).toHaveLength(pipeline.columns.length - 1);
  });
});

describe('mock role catalogue and member mutations', () => {
  it('rejects invalid roles, holder mismatches and member kinds without changing data', () => {
    const backend = new MockBackend();
    expect(errorCode(backend.handle('POST', `${base}/members`, { role: 'missing_role' }))).toBe(
      'unknown_role',
    );
    expect(errorCode(backend.handle('POST', `${base}/members`, { role: 'operator' }))).toBe(
      'role_not_for_ai',
    );
    // A human may hold a role AI members hold too; the owner keeps the release approval duty.
    expect(backend.handle('PATCH', `${base}/members/owner`, { roles: ['operator', 'watchdog'] }).status).toBe(
      200,
    );
    expect(errorCode(backend.handle('PATCH', `${base}/members/owner`, { roles: ['missing_role'] }))).toBe(
      'unknown_role',
    );
    expect(errorCode(backend.handle('PATCH', `${base}/members/owner`, { model: 'sonnet' }))).toBe(
      'not_ai_member',
    );
    expect(errorCode(backend.handle('PATCH', `${base}/members/qa`, { roles: ['qa'] }))).toBe(
      'not_human_member',
    );
    expect(errorCode(backend.handle('POST', `${base}/roles`, { ...role, id: 'qa' }))).toBe(
      'custom_role_shadows_builtin',
    );
    backend.handle('POST', `${base}/roles`, role);
    expect(errorCode(backend.handle('POST', `${base}/roles`, role))).toBe('duplicate_role');
    expect(
      errorCode(backend.handle('PUT', `${base}/roles/data_steward`, { ...role, id: 'other_role' })),
    ).toBe('role_id_mismatch');
    expect(errorCode(backend.handle('DELETE', `${base}/roles/qa`, undefined))).toBe('builtin_role');
    expect(errorCode(backend.handle('PUT', `${base}/roles/qa`, { ...role, id: 'qa' }))).toBe('builtin_role');
    expect(validateProjectConfig(backend.config).filter((i) => i.severity !== 'warning')).toEqual([]);
  });
  it('reports excluded holders and configured temp workers', () => {
    const backend = new MockBackend();
    backend.handle('POST', `${base}/roles`, role);
    backend.handle('POST', `${base}/members`, { role: role.id, handle: 'acme-steward' });
    backend.handle('PATCH', `${base}/members/owner`, { roles: ['operator', role.id] });
    expect(backend.handle('DELETE', `${base}/roles/data_steward`, undefined)).toMatchObject({
      status: 409,
      body: { error: { code: 'role_in_use', details: { members: ['owner', 'acme-steward'] } } },
    });
    expect(backend.handle('PUT', `${base}/roles/data_steward`, { ...role, holders: 'human' })).toMatchObject({
      status: 409,
      body: { error: { details: { members: ['acme-steward'] } } },
    });
    backend.config.team.limits.tempWorkers.role = role.id;
    expect(backend.handle('PUT', `${base}/roles/data_steward`, { ...role, holders: 'human' })).toMatchObject({
      body: { error: { details: { tempWorkers: true } } },
    });
  });
  it('opens the catalogue to members and restricts mutations to owners and admins', () => {
    const backend = new MockBackend();
    backend.viewerHandle = 'kata';
    expect(backend.handle('GET', `${base}/roles`, undefined).status).toBe(200);
    expect(backend.handle('POST', `${base}/roles`, role).status).toBe(403);
    expect(backend.handle('PATCH', `${base}/members/owner`, { roles: [] }).status).toBe(403);
    expect(backend.handle('POST', `${base}/tasks/AC-20/cancel`, {}).status).toBe(403);
    backend.findMember('kata')!.role = 'admin';
    const admin = backend.config.team.members.find((m) => m.handle === 'kata')!;
    if (admin.kind === 'human') admin.access = 'admin';
    expect(backend.handle('POST', `${base}/roles`, role).status).toBe(201);
  });
});

describe('mock task lifecycle', () => {
  it('returns realistic lifecycle errors', () => {
    const backend = new MockBackend();
    expect(errorCode(backend.handle('POST', `${base}/tasks/AC-16/cancel`, {}))).toBe('task_closed');
    expect(errorCode(backend.handle('POST', `${base}/tasks/AC-20/reopen`, {}))).toBe('task_not_cancelled');
  });
  it('cancels every live task session and its open inbox items', () => {
    const backend = new MockBackend();
    backend.handle('POST', `${base}/tasks/AC-25/cancel`, { reason: 'Acme scope changed.' });
    backend.handle('POST', `${base}/tasks/AC-18/cancel`, {});
    backend.handle('POST', `${base}/tasks/AC-21/cancel`, {});
    expect(backend.findTask('AC-25')?.status).toBe('cancelled');
    expect(backend.findSession('ses_ac25_cr')?.state).toBe('exited');
    expect(backend.findSession('ses_ac18_qa')?.state).toBe('exited');
    expect(backend.inbox.find((item) => item.id === 'inb_perm_push')?.state).toBe('cancelled');
    expect(backend.handle('POST', `${base}/tasks/AC-25/reopen`, {}).status).toBe(200);
    expect(backend.findTask('AC-25')).toMatchObject({
      status: 'active',
      assignee: null,
      closedAt: null,
      stageId: 'code_review',
    });
  });
});

describe('mock provider settings', () => {
  it('stores only key status, validates writes and refuses non-owners', () => {
    const backend = new MockBackend();
    const path = '/api/providers/nanogpt/key';
    expect(backend.handle('PUT', path, { key: 'mock-private-sentinel' })).toMatchObject({
      status: 200,
      body: { keys: { nanogpt: { set: true } }, canManageKeys: true },
    });
    expect(JSON.stringify(backend.handle('GET', '/api/providers', undefined).body)).not.toContain(
      'mock-private-sentinel',
    );
    expect(backend.handle('PUT', path, { key: ' ' }).status).toBe(400);
    const hostUser = backend.user;
    backend.user = { ...hostUser, userId: 'usr_not_the_host' };
    expect(backend.handle('PUT', path, { key: 'replacement' }).status).toBe(403);
    expect(backend.handle('DELETE', path, undefined).status).toBe(403);
    expect(backend.handle('GET', '/api/providers', undefined)).toMatchObject({
      body: { canManageKeys: false },
    });
    backend.user = hostUser;
    expect(backend.handle('DELETE', path, undefined)).toMatchObject({
      status: 200,
      body: { keys: { nanogpt: { set: false, setAt: null } } },
    });
    expect(backend.handle('DELETE', path, undefined).status).toBe(200);
  });
  it('reports provider login statuses for any logged-in member', () => {
    const backend = new MockBackend();
    backend.viewerHandle = 'kata';
    backend.providerLoggedIn.codex = false;
    expect(ProvidersView.parse(backend.handle('GET', '/api/providers', undefined).body).providers).toEqual([
      expect.objectContaining({ provider: 'claude', loggedIn: true }),
      expect.objectContaining({ provider: 'codex', loggedIn: false }),
      expect.objectContaining({ provider: 'gemini', loggedIn: true, method: 'google' }),
      expect.objectContaining({ provider: 'nanogpt', loggedIn: false, problem: 'no_key', method: 'api_key' }),
    ]);
    backend.auth = 'login';
    expect(backend.handle('GET', '/api/providers', undefined).status).toBe(401);
  });
  it('hires and edits provider settings, defaults and custom models', () => {
    const backend = new MockBackend();
    expect(
      backend.handle('POST', `${base}/members`, {
        role: 'qa',
        handle: 'acme-codex',
        provider: 'codex',
        effort: 'low',
      }).status,
    ).toBe(201);
    expect(backend.findMember('acme-codex')).toMatchObject({
      provider: 'codex',
      model: 'gpt-6.1-sol',
      effort: 'low',
    });
    expect(
      backend.handle('PATCH', `${base}/members/qa`, { provider: 'codex', effort: 'xhigh' }).body,
    ).toMatchObject({ provider: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh' });
    backend.handle('PATCH', `${base}/members/qa`, { model: 'fictional-codex-model' });
    expect(backend.handle('PATCH', `${base}/members/qa`, { specialty: 'data' }).body).toMatchObject({
      provider: 'codex',
      model: 'fictional-codex-model',
      effort: 'xhigh',
    });
    expect(backend.handle('PATCH', `${base}/members/qa`, { provider: 'claude' }).body).toMatchObject({
      provider: 'claude',
      model: 'opus',
    });
    expect(
      backend.handle('PATCH', `${base}/members/qa`, {
        provider: 'codex',
        model: 'gpt-6-luna',
        effort: 'high',
      }).body,
    ).toMatchObject({ model: 'gpt-6-luna' });
    expect(backend.config.team.members.find((member) => member.handle === 'qa')).toMatchObject({
      provider: 'codex',
      model: 'gpt-6-luna',
      effort: 'high',
    });
    for (const body of [{ provider: 'codex' }, { effort: 'high' }]) {
      expect(errorCode(backend.handle('PATCH', `${base}/members/owner`, body))).toBe('not_ai_member');
    }
    expect(backend.handle('PATCH', `${base}/members/qa`, { effort: 'max' }).status).toBe(200);
    expect(backend.handle('PATCH', `${base}/members/qa`, { effort: null }).body).not.toHaveProperty('effort');
    expect(backend.config.team.members.find((member) => member.handle === 'qa')).not.toHaveProperty('effort');
  });
});

describe('mock repository of a task', () => {
  it('refuses to start a developer on a task without a repository in a project with several', () => {
    const backend = new MockBackend();
    backend.sessions = backend.sessions.filter((session) => session.member !== 'be-1');
    backend.updateTask('AC-24', { repo: null });
    expect(backend.handle('POST', `${base}/tasks/AC-24/start`, {})).toMatchObject({
      status: 409,
      body: { error: { code: 'repo_required', details: { taskKey: 'AC-24' } } },
    });
    expect(backend.findTask('AC-24')).toMatchObject({ assignee: null, stageId: 'ready' });

    backend.updateTask('AC-24', { repo: 'webshop' });
    expect(backend.handle('POST', `${base}/tasks/AC-24/start`, {}).status).toBe(200);
    expect(backend.findTask('AC-24')!.assignee).not.toBeNull();
  });

  it('starts a developer on a task without a repository when the project has one or none', () => {
    for (const repos of [[{ name: 'shop', path: 'shop', defaultBranch: 'main' }], []]) {
      const backend = new MockBackend();
      backend.sessions = backend.sessions.filter((session) => session.member !== 'be-1');
      backend.config.project.repos = repos;
      backend.updateTask('AC-24', { repo: null });
      expect(backend.handle('POST', `${base}/tasks/AC-24/start`, {}).status, String(repos.length)).toBe(200);
    }
  });
});
