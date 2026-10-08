import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { routes } from '@projectman/shared';
import type { ConfigView, CreatedInvitation, ProjectConfig } from '@projectman/shared';
import { createAppHarness, createProject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

/**
 * PM-418: the integrator key may not change the rules of approval labels and gates, owner-only
 * settings, members, or invitations. A refused request writes nothing; the owner's own login does it.
 */
describe('integrator key limits', () => {
  let h: AppHarness;
  let cookie: string;
  let bearer: { authorization: string };
  beforeEach(async () => {
    h = await createAppHarness();
    cookie = await setupOwner(h.app);
    await createProject(h, cookie);
    const response = await h.app.inject({
      method: 'POST',
      url: routes.integratorKey(),
      headers: { cookie },
      payload: { expiresInDays: 30 },
    });
    expect(response.statusCode).toBe(201);
    bearer = { authorization: `Bearer ${response.json().secret}` };
  });
  afterEach(async () => {
    await h.close();
  });

  const send = (
    as: 'key' | 'owner',
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
  ) =>
    h.app.inject({
      method,
      url,
      headers: as === 'key' ? bearer : { cookie },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
  const configView = async () => (await send('owner', 'GET', routes.config('AR'))).json() as ConfigView;
  const invitations = async () =>
    (await send('owner', 'GET', routes.invitations('AR'))).json().invitations as { id: string }[];
  /** What a refused request must leave alone. */
  const state = async () => {
    const view = await configView();
    return { version: view.version, invitations: (await invitations()).map((i) => i.id) };
  };
  const refused = async (
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload: unknown,
    category: string,
  ) => {
    const before = await state();
    const response = await send('key', method, url, payload);
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json().error.code).toBe('owner_login_required');
    expect(response.json().error.details).toEqual({ category });
    expect(await state()).toEqual(before);
  };
  const edited = async (edit: (config: ProjectConfig) => void) => {
    const { config } = await configView();
    edit(config);
    return config;
  };
  const labelOf = (config: ProjectConfig, id: string) => config.pipeline.labels.find((l) => l.id === id)!;
  const memberOf = (config: ProjectConfig, handle: string) =>
    config.team.members.find((m) => m.handle === handle)!;

  describe('PUT and PATCH /config', () => {
    it('refuses the rules of approval labels and gates, and lets the owner change them', async () => {
      const edits: Record<string, (config: ProjectConfig) => void> = {
        'setBy of a human-only label': (c) => (labelOf(c, 'merge-ok').setBy = 'anyone'),
        'notByAuthor of a reviewing label': (c) => delete labelOf(c, 'code-review-ok').notByAuthor,
        'group of a reviewing label': (c) => delete labelOf(c, 'code-review-ok').group,
        'removal of a protected label': (c) =>
          (c.pipeline.labels = c.pipeline.labels.filter((l) => l.id !== 'merge-ok')),
        'a gate condition removed': (c) =>
          c.pipeline.stages.find((s) => s.id === 'merge')!.gate!.conditions.pop(),
        'a stage with a gate removed': (c) =>
          (c.pipeline.stages = c.pipeline.stages.filter((s) => s.id !== 'merge')),
        'a stage moved': (c) => c.pipeline.stages.splice(0, 0, ...c.pipeline.stages.splice(1, 1)),
      };
      for (const [name, edit] of Object.entries(edits)) {
        const config = await edited(edit);
        const before = await configView();
        const response = await send('key', 'PUT', routes.config('AR'), {
          config,
          baseVersion: before.version,
        });
        expect(response.statusCode, name).toBe(403);
        expect(response.json().error, name).toMatchObject({
          code: 'owner_login_required',
          details: { category: 'approval_rules' },
        });
        expect((await configView()).version, name).toBe(before.version);
      }
      const weakened = await edited((c) => (labelOf(c, 'merge-ok').setBy = 'anyone'));
      expect((await send('owner', 'PUT', routes.config('AR'), weakened)).statusCode).toBe(200);
    });

    it('refuses owner-only settings and maxFixRounds', async () => {
      const repo = await edited((c) => (c.project.repos[0]!.path = 'other'));
      const before = await configView();
      const response = await send('key', 'PUT', routes.config('AR'), repo);
      expect(response.statusCode).toBe(403);
      expect(response.json().error.details).toEqual({ category: 'owner_settings' });
      const mode = await edited((c) => {
        const dev = memberOf(c, 'dev-1');
        if (dev.kind === 'ai') dev.permissionMode = 'plan';
      });
      expect((await send('key', 'PUT', routes.config('AR'), mode)).json().error.details).toEqual({
        category: 'owner_settings',
      });
      await refused(
        'PATCH',
        routes.patchConfig('AR'),
        { baseVersion: before.version, limits: { maxFixRounds: 5 } },
        'owner_settings',
      );
      expect((await configView()).version).toBe(before.version);
      const owner = await send('owner', 'PATCH', routes.patchConfig('AR'), {
        baseVersion: before.version,
        limits: { maxFixRounds: 5 },
      });
      expect(owner.statusCode).toBe(200);
    });

    it('refuses a role override that makes a developer a reviewer', async () => {
      const { version } = await configView();
      await refused(
        'PATCH',
        routes.patchConfig('AR'),
        {
          baseVersion: version,
          roleOverrides: { developer: { duties: ['implementation', 'code_review'], instructions: '' } },
        },
        'approval_rules',
      );
    });

    it('refuses a new stage in front of a gate and a change of the gate conditions', async () => {
      const view = await configView();
      const stages = structuredClone(view.config.pipeline);
      stages.stages.splice(3, 0, {
        id: 'shortcut',
        name: 'Shortcut',
        kind: 'done',
        owners: [],
        columnId: 'done',
      });
      await refused(
        'PATCH',
        routes.patchConfig('AR'),
        { baseVersion: view.version, pipeline: stages },
        'approval_rules',
      );
      const gated = structuredClone(view.config.pipeline);
      gated.stages
        .find((s) => s.id === 'merge')!
        .gate!.conditions.push({ type: 'lacks_label', label: 'waiting' });
      await refused(
        'PATCH',
        routes.patchConfig('AR'),
        { baseVersion: view.version, pipeline: gated },
        'approval_rules',
      );
    });

    it('lets the key rename a protected label and a stage without a gate, and change other settings', async () => {
      const view = await configView();
      const pipeline = structuredClone(view.config.pipeline);
      pipeline.labels.find((l) => l.id === 'merge-ok')!.name = 'Merge approved by the owner';
      pipeline.labels.push({ id: 'ui', name: 'UI', setBy: 'anyone' });
      pipeline.stages.find((s) => s.id === 'backlog')!.name = 'Ideas';
      const response = await send('key', 'PATCH', routes.patchConfig('AR'), {
        baseVersion: view.version,
        message: 'Rename',
        project: { name: 'Acme Ltd' },
        limits: { maxConcurrentAi: 5 },
        pipeline,
      });
      expect(response.statusCode, response.body).toBe(200);
      const after = (response.json() as ConfigView).config;
      expect(after.project.name).toBe('Acme Ltd');
      expect(after.team.limits.maxConcurrentAi).toBe(5);
      expect(labelOf(after, 'merge-ok').name).toBe('Merge approved by the owner');
      expect(labelOf(after, 'ui')).toBeTruthy();
      // Sending the same value again is no change, also for the tracked settings.
      const again = await send('key', 'PATCH', routes.patchConfig('AR'), {
        baseVersion: (response.json() as ConfigView).version,
        limits: { maxFixRounds: 3 },
      });
      expect(again.statusCode, again.body).toBe(200);
    });

    it('refuses temporary workers', async () => {
      const { version } = await configView();
      await refused(
        'PATCH',
        routes.patchConfig('AR'),
        { baseVersion: version, limits: { tempWorkers: { enabled: true, max: 2 } } },
        'members',
      );
    });
  });

  describe('revert', () => {
    it('refuses a revert that would weaken an approval and lets the owner do it', async () => {
      const first = await configView();
      const weakened = await edited((c) => (labelOf(c, 'merge-ok').setBy = 'anyone'));
      expect((await send('owner', 'PUT', routes.config('AR'), weakened)).statusCode).toBe(200);
      const before = await state();
      const response = await send('key', 'POST', routes.revertConfig('AR'), { version: first.version });
      expect(response.statusCode).toBe(403);
      expect(response.json().error).toMatchObject({
        code: 'owner_login_required',
        details: { category: 'approval_rules' },
      });
      expect(await state()).toEqual(before);
      const owner = await send('owner', 'POST', routes.revertConfig('AR'), { version: first.version });
      expect(owner.statusCode, owner.body).toBe(200);
      expect(labelOf((owner.json() as ConfigView).config, 'merge-ok').setBy).not.toBe('anyone');
    });
  });

  describe('roles', () => {
    const role = (duties: string[]) => ({
      id: 'checker',
      name: 'Checker',
      summary: 'Checks the work.',
      holders: 'ai',
      duties,
      instructions: '',
    });

    it('refuses a role change that alters who may set a protected label', async () => {
      // A new role nobody holds changes nothing, so the key may add and remove it.
      expect((await send('key', 'POST', routes.roles('AR'), role(['code_review']))).statusCode).toBe(201);
      expect((await send('key', 'DELETE', routes.role('AR', 'checker'))).statusCode).toBe(204);
      // Once a member holds it, its duties decide who sets code-review-ok.
      expect((await send('owner', 'POST', routes.roles('AR'), role(['code_review']))).statusCode).toBe(201);
      const hired = await send('owner', 'POST', routes.members('AR'), {
        role: 'checker',
        displayName: 'Checker One',
      });
      expect(hired.statusCode, hired.body).toBe(201);
      await refused('PUT', routes.role('AR', 'checker'), role(['implementation']), 'approval_rules');
      // The role's instructions concern nobody's approvals.
      const instructions = await send('key', 'PUT', routes.role('AR', 'checker'), {
        ...role(['code_review']),
        instructions: 'Be thorough.',
      });
      expect(instructions.statusCode, instructions.body).toBe(200);
      const owner = await send('owner', 'PUT', routes.role('AR', 'checker'), role(['implementation']));
      expect(owner.statusCode, owner.body).toBe(200);
    });
  });

  describe('members', () => {
    it('refuses adding and removing a human member', async () => {
      const add = { displayName: 'Bob', handle: 'bob', access: 'viewer', roles: [] };
      await refused('POST', routes.addHumanMember('AR'), add, 'members');
      expect((await send('owner', 'POST', routes.addHumanMember('AR'), add)).statusCode).toBe(201);
      await refused('DELETE', routes.removeHuman('AR', 'bob'), undefined, 'members');
      expect((await send('owner', 'DELETE', routes.removeHuman('AR', 'bob'))).statusCode).toBe(204);
    });

    it('refuses hiring and retiring an AI member', async () => {
      const before = await state();
      const hire = await send('key', 'POST', routes.members('AR'), {
        role: 'developer',
        displayName: 'Dev Three',
      });
      expect(hire.statusCode, hire.body).toBe(403);
      expect(hire.json().error.code).toBe('owner_login_required');
      expect(await state()).toEqual(before);
      await refused('DELETE', routes.member('AR', 'dev-2'), {}, 'members');
      expect((await send('owner', 'DELETE', routes.member('AR', 'dev-2'), {})).statusCode).toBe(204);
    });

    it('refuses a change of a member, except leave', async () => {
      const dev = memberOf((await configView()).config, 'dev-1');
      await refused('PATCH', routes.member('AR', 'dev-1'), { model: 'other-model' }, 'members');
      await refused(
        'PATCH',
        routes.member('AR', 'dev-1'),
        { onLeave: true, model: 'other-model' },
        'members',
      );
      const bob = { displayName: 'Bob', handle: 'bob', access: 'viewer', roles: [] };
      expect((await send('owner', 'POST', routes.addHumanMember('AR'), bob)).statusCode).toBe(201);
      await refused('PATCH', routes.member('AR', 'bob'), { access: 'client' }, 'members');
      await refused('PATCH', routes.member('AR', 'bob'), { roles: ['designer'] }, 'members');
      // Taking a duty that holds an approval label is an approval rule.
      await refused('PATCH', routes.member('AR', 'bob'), { roles: ['operator'] }, 'approval_rules');
      const leave = await send('key', 'PATCH', routes.member('AR', 'dev-1'), { onLeave: true });
      expect(leave.statusCode, leave.body).toBe(200);
      expect(memberOf((await configView()).config, 'dev-1')).toMatchObject({ onLeave: true });
      // A field sent again with its current value is no change.
      const back = await send('key', 'PATCH', routes.member('AR', 'dev-1'), {
        onLeave: false,
        displayName: dev.displayName,
      });
      expect(back.statusCode, back.body).toBe(200);
      const owner = await send('owner', 'PATCH', routes.member('AR', 'dev-1'), {
        onLeave: true,
        model: 'other-model',
      });
      expect(owner.statusCode, owner.body).toBe(200);
    });

    it('refuses a full configuration PUT that changes a member besides leave', async () => {
      const leaveOnly = await edited((c) => {
        const dev = memberOf(c, 'dev-2');
        if (dev.kind === 'ai') dev.onLeave = true;
      });
      expect((await send('key', 'PUT', routes.config('AR'), leaveOnly)).statusCode).toBe(200);
      const more = await edited((c) => {
        const dev = memberOf(c, 'dev-2');
        if (dev.kind === 'ai') dev.model = 'other-model';
      });
      const before = await state();
      const response = await send('key', 'PUT', routes.config('AR'), more);
      expect(response.statusCode).toBe(403);
      expect(response.json().error.details).toEqual({ category: 'members' });
      expect(await state()).toEqual(before);
    });
  });

  describe('invitations', () => {
    const invite = { email: 'new@example.test', access: 'developer', roles: [] };

    it('refuses creating one, lists and revokes, and the owner creates', async () => {
      await refused('POST', routes.invitations('AR'), invite, 'invitations');
      const created = await send('owner', 'POST', routes.invitations('AR'), invite);
      expect(created.statusCode, created.body).toBe(201);
      const id = (created.json() as CreatedInvitation).id;
      const list = await send('key', 'GET', routes.invitations('AR'));
      expect(list.statusCode).toBe(200);
      expect(list.json().invitations).toHaveLength(1);
      expect((await send('key', 'DELETE', routes.invitation('AR', id))).statusCode).toBe(204);
    });

    it('refuses accepting one with the key', async () => {
      const created = await send('owner', 'POST', routes.invitations('AR'), invite);
      const { path, id } = created.json() as CreatedInvitation;
      const token = path.replace('/invite/', '');
      const before = await state();
      const response = await send('key', 'POST', routes.acceptInvite(token), {
        name: 'New',
        password: 'correct horse battery',
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error).toMatchObject({
        code: 'owner_login_required',
        details: { category: 'members' },
      });
      expect(await state()).toEqual(before);
      expect(before.invitations).toContain(id);
    });
  });
});
