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
    ];
    for (const { input, status, code } of cases) {
      expect(backend.handle('PATCH', path, input)).toMatchObject({ status, body: { error: { code } } });
      expect(backend.config).toEqual(before);
      expect(backend.history).toEqual(history);
    }
  });

  it('lets admins edit limits but answers owner_only for an owner-only change', () => {
    const backend = new MockBackend();
    backend.viewerHandle = 'kata';
    const admin = backend.config.team.members.find((member) => member.handle === 'kata')!;
    if (admin.kind === 'human') admin.access = 'admin';
    expect(
      backend.handle('PATCH', path, { baseVersion: backend.configVersion, limits: { maxConcurrentAi: 2 } })
        .status,
    ).toBe(200);
    const initial = structuredClone(backend.config);
    const pipeline = structuredClone(initial.pipeline);
    pipeline.labels.find((label) => label.id === 'release-approved')!.setBy = {
      members: ['kata'],
      humansOnly: true,
    };
    expect(backend.handle('PATCH', path, { baseVersion: backend.configVersion, pipeline })).toMatchObject({
      status: 403,
      body: { error: { code: 'owner_only' } },
    });
    expect(backend.config).toEqual(initial);
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

describe('mock owner-only checks on team routes', () => {
  it('runs them on role and member changes too', () => {
    const backend = new MockBackend();
    backend.viewerHandle = 'kata';
    backend.findMember('kata')!.role = 'admin';
    const admin = backend.config.team.members.find((m) => m.handle === 'kata')!;
    if (admin.kind === 'human') admin.access = 'admin';
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
