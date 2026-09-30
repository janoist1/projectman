import { describe, expect, it } from 'vitest';
import { MockBackend } from './backend';

const path = '/api/projects/AC/config';

describe('mock configuration PATCH', () => {
  it('commits, broadcasts and records the human author', () => {
    const backend = new MockBackend();
    const historyLength = backend.history.length;
    const delivered: unknown[] = [];
    const connection = { deliver: (event: unknown) => delivered.push(event) };
    backend.connect(connection);
    backend.handleCommand(connection, { type: 'subscribe_project', projectKey: 'AC' });
    const response = backend.handle('PATCH', path, {
      baseVersion: backend.configVersion,
      message: 'Update Acme',
      project: { name: 'Acme store' },
    });
    expect(response.status).toBe(200);
    expect(backend.config.project.name).toBe('Acme store');
    expect(backend.history).toHaveLength(historyLength + 1);
    expect(backend.history[0]).toMatchObject({
      message: 'Update Acme',
      author: backend.user.name,
      version: backend.configVersion,
    });
    expect(delivered).toContainEqual({
      type: 'config_changed',
      projectKey: 'AC',
      version: backend.configVersion,
    });
  });

  it('rejects conflicts and schema or invariant failures without changing history', () => {
    const backend = new MockBackend();
    const before = structuredClone(backend.config);
    const history = structuredClone(backend.history);
    const cases = [
      { input: { baseVersion: 'old', project: { name: 'Old' } }, status: 409, code: 'config_conflict' },
      {
        input: { baseVersion: backend.configVersion, limits: { maxConcurrentAi: 0 } },
        status: 400,
        code: 'config_invalid',
      },
      {
        input: { baseVersion: backend.configVersion, limits: { tempWorkers: { role: 'operator' } } },
        status: 400,
        code: 'config_invalid',
      },
    ];
    for (const { input, status, code } of cases) {
      expect(backend.handle('PATCH', path, input)).toMatchObject({ status, body: { error: { code } } });
      expect(backend.config).toEqual(before);
      expect(backend.history).toEqual(history);
    }
  });

  it('allows admin limits but rejects changing or removing any human approval gate', () => {
    const backend = new MockBackend();
    backend.viewerHandle = 'kata';
    const admin = backend.config.team.members.find((member) => member.handle === 'kata')!;
    if (admin.kind === 'human') admin.access = 'admin';
    backend.config.pipeline.labels.push({
      id: 'merge-approved',
      name: 'Merge jóváhagyva',
      setBy: { members: ['owner'], humansOnly: true },
    });
    backend.config.pipeline.stages.find((stage) => stage.id === 'merge')!.gate = {
      conditions: [{ type: 'has_label', label: 'merge-approved' }],
    };
    expect(
      backend.handle('PATCH', path, { baseVersion: backend.configVersion, limits: { maxConcurrentAi: 2 } })
        .status,
    ).toBe(200);
    const initial = structuredClone(backend.config);
    for (const id of ['merge', 'release']) {
      for (const operation of ['change', 'remove', 'removeStage']) {
        const pipeline = structuredClone(initial.pipeline);
        const stage = pipeline.stages.find((stage) => stage.id === id)!;
        if (operation === 'change')
          pipeline.labels.find(
            (label) => label.id === `${id === 'merge' ? 'merge' : 'release'}-approved`,
          )!.setBy = {
            members: ['kata'],
            humansOnly: true,
          };
        if (operation === 'remove') stage.gate = undefined;
        if (operation === 'removeStage') pipeline.stages = pipeline.stages.filter((stage) => stage.id !== id);
        expect(backend.handle('PATCH', path, { baseVersion: backend.configVersion, pipeline })).toMatchObject(
          { status: 403, body: { error: { code: 'owner_only' } } },
        );
        expect(backend.config).toEqual(initial);
      }
    }
  });

  it.each(['client', 'viewer', 'developer'] as const)('rejects %s writes', (access) => {
    const backend = new MockBackend();
    backend.viewerHandle = 'kata';
    const member = backend.config.team.members.find((member) => member.handle === 'kata')!;
    if (member.kind === 'human') member.access = access;
    expect(
      backend.handle('PATCH', path, { baseVersion: backend.configVersion, project: { name: 'Forbidden' } }),
    ).toMatchObject({ status: 403, body: { error: { code: 'insufficient_access' } } });
  });
});

describe('mock duty configuration', () => {
  it('saves and resets built-in bundles, rejects orphan dependencies and AI conflicts', () => {
    const backend = new MockBackend();
    const patch = (body: Record<string, unknown>) =>
      backend.handle('PATCH', path, { baseVersion: backend.configVersion, ...body });
    expect(patch({ roleOverrides: { developer: { duties: ['implementation', 'docs'] } } }).status).toBe(200);
    expect(backend.config.team.roleOverrides?.developer?.duties).toContain('docs');
    expect(patch({ roleOverrides: {} }).status).toBe(200);
    const pipeline = structuredClone(backend.config.pipeline);
    pipeline.stages[1]!.duty = 'research';
    expect(patch({ pipeline })).toMatchObject({ body: { error: { code: 'config_invalid' } } });
    expect(patch({ roleOverrides: { developer: { duties: ['release_approval'] } } })).toMatchObject({
      body: { error: { code: 'config_invalid' } },
    });
  });
  it('protects release duties through role and member mutations too', () => {
    const backend = new MockBackend();
    backend.viewerHandle = 'kata';
    backend.findMember('kata')!.role = 'admin';
    const admin = backend.config.team.members.find((m) => m.handle === 'kata')!;
    if (admin.kind === 'human') admin.access = 'admin';
    expect(
      backend.handle('PATCH', path, { baseVersion: backend.configVersion, releaseFourEyes: true }),
    ).toMatchObject({ status: 403, body: { error: { code: 'owner_only' } } });
    expect(
      backend.handle('POST', '/api/projects/AC/roles', {
        id: 'release_lead',
        name: 'Release lead',
        summary: 'Decides.',
        duties: ['release_approval'],
      }),
    ).toMatchObject({ status: 403, body: { error: { code: 'owner_only' } } });
    expect(backend.handle('PATCH', '/api/projects/AC/members/kata', { roles: ['operator'] })).toMatchObject({
      status: 403,
      body: { error: { code: 'owner_only' } },
    });
  });
});

describe('mock duty runtime rules', () => {
  it('rejects self-review by assignee and PR author, accepting independent results', () => {
    const backend = new MockBackend();
    backend.config.pipeline.labels.push({
      id: 'reviewed',
      name: 'Átnézve',
      setBy: 'anyone',
      notByAuthor: true,
    });
    for (const member of backend.config.team.members)
      if (member.kind === 'human' && ['kata', 'bence'].includes(member.handle)) member.access = 'developer';
    for (const member of backend.members)
      if (['kata', 'bence'].includes(member.handle)) member.role = 'developer';
    const task = backend.tasks[0]!;
    task.assignee = 'kata';
    task.links.push({ kind: 'pull_request', ref: '999', author: 'bence' });
    const label = (viewer: string) => {
      backend.viewerHandle = viewer;
      return backend.handle('POST', `/api/projects/AC/tasks/${task.key}/labels`, { add: ['reviewed'] });
    };
    for (const viewer of ['kata', 'bence'])
      expect(label(viewer)).toMatchObject({ body: { error: { code: 'self_review_forbidden' } } });
    expect(label('owner').status).toBe(200);
    expect(task.labels).toContain('reviewed');
  });
  it('resolves duty approvers and prevents AI approval and stale four-eyes approval', () => {
    const backend = new MockBackend();
    const task = backend.tasks[0]!;
    task.stageId = 'merge';
    task.assignee = 'owner';
    backend.config.pipeline.labels = backend.config.pipeline.labels.map((label) =>
      label.id === 'release-approved'
        ? { ...label, setBy: { duties: ['release_approval'], humansOnly: true } }
        : label,
    );
    backend.config.pipeline.stages.find((s) => s.id === 'release')!.gate = {
      conditions: [{ type: 'has_label', label: 'release-approved' }],
    };
    const moved = backend.handle('PATCH', `/api/projects/AC/tasks/${task.key}`, { stageId: 'release' });
    expect(moved.status).toBe(409);
    const item = backend.inbox.find(
      (i) => i.taskKey === task.key && i.kind === 'decision' && i.state === 'open',
    )!;
    expect(item.assignees).toContain('owner');
    backend.viewerHandle = 'fe-1';
    expect(
      backend.handle('POST', `/api/projects/AC/inbox/${item.id}/resolve`, { optionId: 'approve' }),
    ).toMatchObject({ body: { error: { code: 'ai_approval_forbidden' } } });
    backend.viewerHandle = 'owner';
    backend.config.team.releaseFourEyes = true;
    expect(
      backend.handle('POST', `/api/projects/AC/inbox/${item.id}/resolve`, { optionId: 'approve' }),
    ).toMatchObject({ body: { error: { code: 'release_four_eyes' } } });
    expect(item.state).toBe('open');
  });
});
