import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Me, ServerEvent, routes } from '@projectman/shared';
import type { BoardView, MemberProfile, MemberView } from '@projectman/shared';
import { addHumanAndLogin, createAppHarness, createProject, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import { withoutOnboarding } from './helpers/onboarding';

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

  it('includes the provider quota wait of a waking queued item in the roster', async () => {
    const { domain, repos } = h.app.projectman;
    const since = '2026-10-25T12:00:00.000Z';
    const until = '2026-10-25T13:00:00.000Z';
    repos.memberQueue.insert({
      id: 'quota-message',
      projectKey: 'AR',
      member: 'dev-1',
      kind: 'message',
      source: { type: 'message', id: 'waiting-message' },
      place: { type: 'general' },
      taskKey: null,
      wake: true,
      title: 'Waiting message',
      from: 'owner',
      queuedAt: since,
    });
    repos.memberQueue.setWait('quota-message', 'provider_rate_limited', since, { provider: 'gemini', until });

    const roster = domain.members.rosterFor(await domain.projects.config('AR'));
    expect(roster.find((member) => member.handle === 'dev-1')?.quotaWaiting).toEqual({
      reason: 'provider_rate_limited',
      provider: 'gemini',
      until,
      since,
    });
  });

  it('shows a client card activity on every member read, like any member (PM-79)', async () => {
    const domain = h.app.projectman.domain;
    const client = await addHumanAndLogin(h.app, { handle: 'client', name: 'Client', access: 'client' });
    const task = await domain.tasks.create('AR', { title: 'Work' }, OWNER_ACTOR);
    domain.members.setState('AR', 'dev-1', 'working', 'Read file', task.key);
    const read = async (auth: string) => {
      const members = (await inject(h.app, 'GET', routes.members('AR'), auth)).json<MemberView[]>();
      const board = (await inject(h.app, 'GET', '/api/projects/AR/board', auth)).json<BoardView>();
      const profile = (
        await inject(h.app, 'GET', routes.memberProfile('AR', 'dev-1'), auth)
      ).json<MemberProfile>();
      return [
        members.find((m) => m.handle === 'dev-1'),
        board.members.find((m) => m.handle === 'dev-1'),
        profile.member,
      ];
    };
    for (const member of await read(cookie))
      expect(member).toMatchObject({ activity: 'Read file', activityTaskKey: task.key });
    for (const member of await read(client))
      expect(member).toMatchObject({ activity: 'Read file', activityTaskKey: task.key });
  });

  it('publishes a source card change even when status and activity stay the same', () => {
    const domain = h.app.projectman.domain;
    const events: ServerEvent[] = [];
    domain.bus.subscribe((event) => events.push(event));
    domain.members.setState('AR', 'dev-1', 'working', 'Read file', 'AR-1');
    domain.members.setState('AR', 'dev-1', 'working', 'Read file', 'AR-2');
    domain.members.setState('AR', 'dev-1', 'working', 'Read file', 'AR-2');
    expect(
      events.filter((event) => event.type === 'member_state').map((event) => event.activityTaskKey),
    ).toEqual(['AR-1', 'AR-2']);
    expect(h.app.projectman.repos.memberState.get('AR', 'dev-1')?.activityTaskKey).toBe('AR-2');
  });
  it('returns effective email settings and preserves omitted values during AI member updates', async () => {
    const members = h.app.projectman.domain.members;
    expect(
      members
        .rosterFor(await h.app.projectman.domain.projects.config('AR'))
        .find((member) => member.handle === 'dev-1')?.email,
    ).toEqual({ enabled: false, sendWithoutApproval: false });
    await members.update('AR', 'dev-1', { email: { enabled: true, sendWithoutApproval: true } }, by);
    const updated = await members.update('AR', 'dev-1', { email: { enabled: true } }, by);
    expect(updated.email).toEqual({ enabled: true, sendWithoutApproval: true });
  });
  it('clears sending without approval when sending is switched off, and does not bring it back on', async () => {
    const members = h.app.projectman.domain.members;
    await members.update('AR', 'dev-1', { email: { enabled: true, sendWithoutApproval: true } }, by);
    const off = await members.update('AR', 'dev-1', { email: { enabled: false } }, by);
    expect(off.email).toEqual({ enabled: false, sendWithoutApproval: false });
    const on = await members.update('AR', 'dev-1', { email: { enabled: true } }, by);
    expect(on.email).toEqual({ enabled: true, sendWithoutApproval: false });
  });
  describe('the mailbox name of an AI member (PM-989)', () => {
    const emailOf = async (handle: string) => {
      const member = (await h.app.projectman.domain.projects.config('AR')).team.members.find(
        (candidate) => candidate.handle === handle,
      );
      return member?.kind === 'ai' ? member.email : undefined;
    };

    it('stores a free name and removes the field again when the name is the handle', async () => {
      const members = h.app.projectman.domain.members;
      await members.update('AR', 'dev-1', { email: { enabled: true, mailbox: 'builder' } }, by);
      expect(await emailOf('dev-1')).toMatchObject({ enabled: true, mailbox: 'builder' });
      await members.update('AR', 'dev-1', { email: { mailbox: 'dev-1' } }, by);
      expect(await emailOf('dev-1')).toMatchObject({ enabled: true });
      expect(await emailOf('dev-1')).not.toHaveProperty('mailbox');
    });

    it('keeps the name when only the switches change', async () => {
      const members = h.app.projectman.domain.members;
      await members.update('AR', 'dev-1', { email: { enabled: true, mailbox: 'builder' } }, by);
      await members.update('AR', 'dev-1', { email: { enabled: false } }, by);
      expect(await emailOf('dev-1')).toMatchObject({ enabled: false, mailbox: 'builder' });
    });

    it('refuses the name of another member of the project, whatever its switches', async () => {
      await expect(
        h.app.projectman.domain.members.update('AR', 'dev-1', { email: { mailbox: 'dev-2' } }, by),
      ).rejects.toMatchObject({ code: 'email_mailbox_taken', details: { mailbox: 'dev-2' } });
    });

    it('refuses the name of a member of another project', async () => {
      const { domain } = h.app.projectman;
      await withoutOnboarding(domain, () =>
        domain.projects.create(
          { key: 'BR', name: 'beta', workspacePath: h.workspace, templateId: 'test' },
          OWNER,
        ),
      );
      await domain.members.update('BR', 'dev-1', { email: { mailbox: 'shared-name' } }, by);
      await expect(
        domain.members.update('AR', 'dev-1', { email: { mailbox: 'shared-name' } }, by),
      ).rejects.toMatchObject({ code: 'email_mailbox_taken' });
    });
  });
  it('refuses AI email settings on a human member', async () => {
    await expect(
      h.app.projectman.domain.members.update('AR', 'owner', { email: { enabled: true } }, by),
    ).rejects.toMatchObject({ code: 'not_ai_member' });
  });
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

  describe('AI member delivery settings', () => {
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

    it('allows an admin to enable email but reserves approval policy changes to the owner', async () => {
      const admin = await inviteAs('admin', 'admin@example.test');
      const enabled = await inject(h.app, 'PATCH', routes.member('AR', 'dev-1'), admin, {
        email: { enabled: true },
      });
      expect(enabled.statusCode).toBe(200);
      expect(enabled.json().email).toEqual({ enabled: true, sendWithoutApproval: false });
      const denied = await inject(h.app, 'PATCH', routes.member('AR', 'dev-1'), admin, {
        email: { sendWithoutApproval: true },
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error.code).toBe('owner_only');
    });

    it('allows an admin to switch off a sender that sends without approval', async () => {
      const admin = await inviteAs('admin', 'admin@example.test');
      await h.app.projectman.domain.members.update(
        'AR',
        'dev-1',
        { email: { enabled: true, sendWithoutApproval: true } },
        by,
      );
      const off = await inject(h.app, 'PATCH', routes.member('AR', 'dev-1'), admin, {
        email: { enabled: false },
      });
      expect(off.statusCode).toBe(200);
      expect(off.json().email).toEqual({ enabled: false, sendWithoutApproval: false });
    });

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
