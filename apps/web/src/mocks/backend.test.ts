import { describe, expect, it } from 'vitest';
import { ProvidersView, Task, validateProjectConfig } from '@projectman/shared';
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
function errorCode(response: { body?: unknown }) {
  return (response.body as { error: { code: string } }).error.code;
}

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
    expect(backend.handle('PATCH', `${base}/tasks/AC-20`, { assignee: null }).status).toBe(403);
    backend.findMember('kata')!.role = 'admin';
    const admin = backend.config.team.members.find((m) => m.handle === 'kata')!;
    if (admin.kind === 'human') admin.access = 'admin';
    expect(backend.handle('POST', `${base}/roles`, role).status).toBe(201);
  });
});

describe('mock task lifecycle', () => {
  it('returns realistic errors and retains previous assignment in the timeline', () => {
    const backend = new MockBackend();
    expect(errorCode(backend.handle('POST', `${base}/tasks/AC-16/cancel`, {}))).toBe('task_closed');
    expect(errorCode(backend.handle('POST', `${base}/tasks/AC-20/reopen`, {}))).toBe('task_not_cancelled');
    expect(errorCode(backend.handle('PATCH', `${base}/tasks/AC-20`, { assignee: 'missing-member' }))).toBe(
      'unknown_member',
    );
    expect(backend.handle('PATCH', `${base}/tasks/AC-20`, { assignee: null })).toMatchObject({
      status: 409,
      body: { error: { code: 'task_session_live', details: { sessionId: 'ses_ac20_be1' } } },
    });
    backend.handle('POST', `${base}/sessions/ses_ac20_be1/stop`, {});
    expect(backend.handle('PATCH', `${base}/tasks/AC-20`, { assignee: null }).status).toBe(200);
    expect(backend.timeline.at(-1)).toMatchObject({
      type: 'task_assigned',
      data: { previous: 'be-1', assignee: null },
    });
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

describe('mock task updates', () => {
  /** A label anyone may set, required to enter code review. */
  function gatedBackend() {
    const backend = new MockBackend();
    backend.config.pipeline.labels.push({ id: 'ready-for-review', name: 'Ready', setBy: 'anyone' });
    backend.config.pipeline.stages.find((stage) => stage.id === 'code_review')!.gate = {
      conditions: [{ type: 'has_label', label: 'ready-for-review' }],
    };
    return backend;
  }
  const newEvents = (backend: MockBackend, before: number) =>
    backend.timeline.slice(before).map((event) => event.type);

  it('applies fields and labels before the move, so one change can pass a gate', () => {
    const backend = gatedBackend();
    const task = backend.findTask('AC-20')!;
    const before = backend.timeline.length;
    const response = backend.handle('PATCH', `${base}/tasks/AC-20`, {
      title: 'Fictional backup check',
      labels: [...task.labels, 'ready-for-review'],
      stageId: 'code_review',
    });
    expect(response.status).toBe(200);
    expect(Task.parse(response.body)).toMatchObject({
      title: 'Fictional backup check',
      stageId: 'code_review',
    });
    expect(backend.findTask('AC-20')?.labels).toContain('ready-for-review');
    expect(newEvents(backend, before)).toEqual(['task_updated', 'task_labels_changed', 'task_stage_changed']);
  });

  it.each([
    ['a blocked gate', { stageId: 'code_review' }, 409, 'gate_blocked'],
    ['a refused label', { labels: ['pr-merged'] }, 403, 'label_not_allowed'],
  ] as const)('changes nothing when %s refuses the update', (_case, change, status, code) => {
    const backend = gatedBackend();
    const task = structuredClone(backend.findTask('AC-20')!);
    const before = backend.timeline.length;
    expect(
      backend.handle('PATCH', `${base}/tasks/AC-20`, { title: 'Must not save', ...change }),
    ).toMatchObject({ status, body: { error: { code } } });
    expect(backend.findTask('AC-20')).toEqual(task);
    expect(backend.timeline).toHaveLength(before);
  });

  it('applies the rest and asks for the approval once when the move needs one', () => {
    const backend = new MockBackend();
    const open = () =>
      backend.inbox.filter(
        (item) => item.taskKey === 'AC-28' && item.kind === 'decision' && item.state === 'open',
      );
    backend.handle('PATCH', `${base}/tasks/AC-28`, { stageId: 'merge' });
    for (const title of ['Fictional shipping fee', 'Fictional shipping fee v2'])
      expect(backend.handle('PATCH', `${base}/tasks/AC-28`, { title, stageId: 'release' })).toMatchObject({
        status: 409,
        body: { error: { code: 'approval_requested', details: { inboxItemIds: [open()[0]?.id] } } },
      });
    expect(backend.findTask('AC-28')).toMatchObject({
      title: 'Fictional shipping fee v2',
      stageId: 'merge',
      status: 'waiting',
    });
    expect(open()).toHaveLength(1);
  });
  it.each([
    ['four eyes leave only its author', 'release_four_eyes'],
    ["the label's own rule leaves only its author", 'self_review_forbidden'],
    ['nobody holds the label', 'missing_duty_holder'],
  ] as const)('changes nothing when nobody may give the approval: %s', (_case, code) => {
    const backend = new MockBackend();
    backend.handle('PATCH', `${base}/tasks/AC-28`, { stageId: 'merge' });
    backend.findTask('AC-28')!.links[0]!.author = 'owner';
    const approval = backend.config.pipeline.labels.find((label) => label.id === 'release-approved')!;
    if (code === 'release_four_eyes') backend.config.team.releaseFourEyes = true;
    if (code === 'self_review_forbidden') approval.notByAuthor = true;
    if (code === 'missing_duty_holder') approval.setBy = { members: [], humansOnly: true };
    const task = structuredClone(backend.findTask('AC-28')!);
    const before = backend.timeline.length;
    expect(
      backend.handle('PATCH', `${base}/tasks/AC-28`, { title: 'Must not save', stageId: 'release' }),
    ).toMatchObject({
      status: 409,
      body: { error: { code, details: { stageId: 'release', label: 'release-approved' } } },
    });
    expect(backend.findTask('AC-28')).toEqual(task);
    expect(backend.timeline).toHaveLength(before);
    expect(backend.inbox.filter((item) => item.taskKey === 'AC-28' && item.state === 'open')).toEqual([]);
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
    backend.viewerHandle = 'kata';
    expect(backend.handle('PUT', path, { key: 'replacement' }).status).toBe(403);
    expect(backend.handle('DELETE', path, undefined).status).toBe(403);
    expect(backend.handle('GET', '/api/providers', undefined)).toMatchObject({
      body: { canManageKeys: false },
    });
    backend.viewerHandle = 'owner';
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
      expect.objectContaining({ provider: 'nanogpt', loggedIn: true, method: 'api_key' }),
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
  const sessionsOf = (backend: MockBackend, key: string) =>
    backend.sessions.filter(
      (session) => session.workItem.type === 'task' && session.workItem.taskKey === key,
    );

  it('sets and clears the repository, records the change and refuses unknown names', () => {
    const backend = new MockBackend();
    backend.handle('POST', `${base}/sessions/ses_ac20_be1/stop`, {});
    const before = backend.timeline.length;
    expect(errorCode(backend.handle('PATCH', `${base}/tasks/AC-20`, { repo: 'mobile' }))).toBe(
      'unknown_repo',
    );
    expect(backend.findTask('AC-20')!.repo).toBe('infra');
    expect(backend.timeline).toHaveLength(before);

    expect(backend.handle('PATCH', `${base}/tasks/AC-20`, { repo: 'admin' }).body).toMatchObject({
      repo: 'admin',
    });
    expect(backend.timeline.at(-1)).toMatchObject({
      type: 'task_updated',
      data: { fields: ['repo'], repo: 'admin', previousRepo: 'infra' },
    });
    // The same value is no change.
    const events = backend.timeline.length;
    expect(backend.handle('PATCH', `${base}/tasks/AC-20`, { repo: 'admin' }).status).toBe(200);
    expect(backend.timeline).toHaveLength(events);

    expect(backend.handle('PATCH', `${base}/tasks/AC-20`, { repo: null }).body).toMatchObject({ repo: null });
    expect(backend.timeline.at(-1)).toMatchObject({
      data: { fields: ['repo'], repo: null, previousRepo: 'admin' },
    });
  });

  it('refuses the change while a session of the task is running, like the server', () => {
    const backend = new MockBackend();
    expect(sessionsOf(backend, 'AC-20').some((session) => session.state !== 'exited')).toBe(true);
    expect(backend.handle('PATCH', `${base}/tasks/AC-20`, { repo: 'admin' })).toMatchObject({
      status: 409,
      body: { error: { code: 'task_session_live', details: { sessionId: 'ses_ac20_be1' } } },
    });
    expect(backend.findTask('AC-20')!.repo).toBe('infra');
  });

  it('refuses to start a developer on a task without a repository in a project with several', () => {
    const backend = new MockBackend();
    backend.updateTask('AC-24', { repo: null });
    expect(backend.handle('POST', `${base}/tasks/AC-24/start`, {})).toMatchObject({
      status: 409,
      body: { error: { code: 'repo_required', details: { taskKey: 'AC-24' } } },
    });
    expect(backend.findTask('AC-24')).toMatchObject({ assignee: null, stageId: 'ready' });

    backend.handle('PATCH', `${base}/tasks/AC-24`, { repo: 'webshop' });
    expect(backend.handle('POST', `${base}/tasks/AC-24/start`, {}).status).toBe(200);
    expect(backend.findTask('AC-24')!.assignee).not.toBeNull();
  });

  it('starts a developer on a task without a repository when the project has one or none', () => {
    for (const repos of [[{ name: 'shop', path: 'shop', defaultBranch: 'main' }], []]) {
      const backend = new MockBackend();
      backend.config.project.repos = repos;
      backend.updateTask('AC-24', { repo: null });
      expect(backend.handle('POST', `${base}/tasks/AC-24/start`, {}).status, String(repos.length)).toBe(200);
    }
  });
});
