import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Me, ServerEvent } from '@projectman/shared';
import { createAppHarness, createProject, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { OWNER, OWNER_ACTOR } from './helpers/domain-harness';

describe('memberships and member snapshots', () => {
  let h: AppHarness;
  let cookie: string;
  beforeEach(async () => {
    h = await createAppHarness();
    cookie = await setupOwner(h.app);
    await createProject(h, cookie);
  });
  afterEach(async () => h.close());

  const by = { actor: OWNER_ACTOR, author: OWNER, sponsor: 'owner' };
  it('uses the new provider default unless the same request supplies a compatible model', async () => {
    const members = h.app.projectman.domain.members;
    const member = await members.hire('AR', { role: 'qa', provider: 'gemini' }, by);
    expect(member.model).toBe('gemini-3.8-flash');
    await members.update('AR', member.handle, { model: 'gemini-3.1-pro' }, by);
    expect((await members.update('AR', member.handle, { provider: 'codex' }, by)).model).toBe('gpt-6.1-sol');
    expect(
      (await members.update('AR', member.handle, { provider: 'gemini', model: 'gemini-3.1-pro' }, by)).model,
    ).toBe('gemini-3.1-pro');
    expect(
      (await members.update('AR', member.handle, { provider: 'claude', model: 'gemini-3.1-pro' }, by)).model,
    ).toBe('opus');
  });

  it('lists only the authenticated user’s projects and reflects changed membership roles', async () => {
    await h.app.projectman.domain.projects.create(
      { key: 'OTHER', name: 'Other fictional project', workspacePath: h.workspace, templateId: 'test' },
      { name: 'Other owner', email: 'other@example.test' },
    );
    await h.app.projectman.domain.members.update('AR', 'owner', { roles: ['operator', 'qa'] }, by);
    const me = Me.parse((await inject(h.app, 'GET', '/api/me', cookie)).json());
    expect(me.handles).toEqual({ AR: 'owner' });
    expect(me.projects).toEqual([{ key: 'AR', name: 'acme', access: 'owner', roles: ['operator', 'qa'] }]);
  });

  it('publishes member snapshots on hire, update, retirement and invitation acceptance', async () => {
    const events: ServerEvent[] = [];
    h.app.projectman.domain.bus.subscribe((event) => events.push(ServerEvent.parse(event)));
    const member = await h.app.projectman.domain.members.hire('AR', { role: 'qa' }, by);
    await h.app.projectman.domain.members.update('AR', member.handle, { model: 'fictional-new-model' }, by);
    await h.app.projectman.domain.members.retire('AR', member.handle, {}, by);
    const invite = await inject(h.app, 'POST', '/api/projects/AR/invites', cookie, {
      email: 'reader@example.test',
      access: 'viewer',
      roles: ['qa'],
    });
    await inject(h.app, 'POST', invite.json().path.replace('/invite/', '/api/invites/') + '/accept', null, {
      name: 'Fictional reader',
      password: 'correct horse battery',
    });
    expect(events.filter((e) => e.type === 'member_changed')).toEqual([
      expect.objectContaining({
        handle: member.handle,
        member: expect.objectContaining({ model: member.model }),
      }),
      expect.objectContaining({
        handle: member.handle,
        member: expect.objectContaining({ model: 'fictional-new-model' }),
      }),
      expect.objectContaining({ handle: member.handle, member: null }),
      expect.objectContaining({
        handle: 'fictional-reader',
        member: expect.objectContaining({ kind: 'human', role: 'viewer', roles: ['qa'] }),
      }),
    ]);
  });
});
