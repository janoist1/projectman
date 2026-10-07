import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Me, ServerEvent, routes } from '@projectman/shared';
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

  describe('the outbound network setting (PM-355)', () => {
    /** Invites a human with the given access and returns their login cookie. */
    async function inviteAs(access: 'admin' | 'developer', email: string): Promise<string> {
      const invite = await inject(h.app, 'POST', '/api/projects/AR/invites', cookie, {
        email,
        access,
        roles: ['qa'],
      });
      const accepted = await inject(
        h.app,
        'POST',
        invite.json().path.replace('/invite/', '/api/invites/') + '/accept',
        null,
        { name: 'Fictional person', password: 'correct horse battery' },
      );
      const setCookie = accepted.headers['set-cookie'];
      return Array.isArray(setCookie) ? setCookie[0]! : setCookie!;
    }

    it('is on for a new member unless the owner hires it with the network off', async () => {
      const defaulted = await inject(h.app, 'POST', routes.members('AR'), cookie, { role: 'developer' });
      expect(defaulted.statusCode).toBe(201);
      expect(defaulted.json().outboundNetwork).toBe(true);

      const off = await inject(h.app, 'POST', routes.members('AR'), cookie, {
        role: 'qa',
        outboundNetwork: false,
      });
      expect(off.statusCode).toBe(201);
      expect(off.json().outboundNetwork).toBe(false);
    });

    it('is changed by the owner and by nobody else', async () => {
      const hired = await inject(h.app, 'POST', routes.members('AR'), cookie, { role: 'developer' });
      const handle: string = hired.json().handle;

      const changed = await inject(h.app, 'PATCH', routes.member('AR', handle), cookie, {
        outboundNetwork: false,
      });
      expect(changed.statusCode).toBe(200);
      expect(changed.json().outboundNetwork).toBe(false);

      // An admin may hire and edit members, but not the permission settings (owner only).
      const admin = await inviteAs('admin', 'admin@example.test');
      const patched = await inject(h.app, 'PATCH', routes.member('AR', handle), admin, {
        outboundNetwork: true,
      });
      expect(patched.statusCode).toBe(403);
      const hiredOff = await inject(h.app, 'POST', routes.members('AR'), admin, {
        role: 'qa',
        outboundNetwork: false,
      });
      expect(hiredOff.statusCode).toBe(403);
      const hiredDefault = await inject(h.app, 'POST', routes.members('AR'), admin, { role: 'qa' });
      expect(hiredDefault.statusCode).toBe(201);
      expect(hiredDefault.json().outboundNetwork).toBe(true);
    });

    it('applies to AI members only', async () => {
      const res = await inject(h.app, 'PATCH', routes.member('AR', 'owner'), cookie, {
        outboundNetwork: false,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('not_ai_member');
    });

    it('reads as on for a member saved before the setting existed', async () => {
      const members = h.app.projectman.domain.members;
      const member = await members.hire('AR', { role: 'qa', outboundNetwork: false }, by);
      await h.app.projectman.domain.projects.update('AR', by, (draft) => {
        const saved = draft.team.members.find((m) => m.handle === member.handle);
        if (saved?.kind === 'ai') delete saved.outboundNetwork;
        return 'Drop the outbound network setting';
      });

      const roster = await inject(h.app, 'GET', routes.members('AR'), cookie);
      const view = roster.json().find((m: { handle: string }) => m.handle === member.handle);
      expect(view.outboundNetwork).toBe(true);
    });
  });
});
