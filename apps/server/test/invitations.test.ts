import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreatedInvitation, Me, PublicInviteView } from '@projectman/shared';
import { cookieOf, createAppHarness, createProject } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

const ownerLogin = { name: 'Te', email: 'owner@acme.test', password: 'correct horse battery' };
const newAccount = { name: 'Kata', password: 'correct horse battery' };
const invitation = {
  email: 'kata@acme.test',
  displayName: 'Kata',
  access: 'developer',
  roles: ['developer', 'qa'],
};

describe('colleague invitation API', () => {
  let h: AppHarness;
  let owner: string;
  let now: Date;
  beforeEach(async () => {
    now = new Date('2026-09-30T10:00:00.000Z');
    h = await createAppHarness({ now: () => now });
    const setup = await h.app.inject({ method: 'POST', url: '/api/setup', payload: ownerLogin });
    owner = cookieOf(setup);
    await createProject(h, owner);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await h.close();
  });

  async function call(method: 'GET' | 'POST' | 'DELETE', url: string, cookie?: string, payload?: object) {
    return h.app.inject({ method, url, headers: cookie ? { cookie } : {}, ...(payload ? { payload } : {}) });
  }
  async function invite(input = invitation, cookie = owner): Promise<CreatedInvitation> {
    const response = await call('POST', '/api/projects/AR/invites', cookie, input);
    expect(response.statusCode, response.body).toBe(201);
    return response.json();
  }
  const publicPath = (invite: CreatedInvitation) => invite.path.replace('/invite/', '/api/invites/');

  it('returns a one-time path, stores only SHA-256, lists without secrets and exposes public details', async () => {
    const created = await invite({ ...invitation, email: ' KATA@acme.test ' });
    const token = created.path.split('/').at(-1)!;
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(created).not.toHaveProperty('tokenHash');
    expect(Date.parse(created.expiresAt) - Date.parse(created.createdAt)).toBe(7 * 24 * 60 * 60_000);
    const stored = h.app.projectman.repos.invitations.get(created.id)!;
    expect(stored.tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(created.email).toBe('kata@acme.test');
    const list = await call('GET', '/api/projects/AR/invites', owner);
    expect(list.json().invitations).toEqual([expect.objectContaining({ id: created.id })]);
    expect(list.body).not.toContain(token);
    expect(list.body).not.toContain('tokenHash');
    const inspected = await call('GET', publicPath(created));
    expect(inspected.statusCode).toBe(200);
    expect(inspected.json<PublicInviteView>()).toMatchObject({
      projectKey: 'AR',
      projectName: 'acme',
      inviterName: 'Te',
      access: 'developer',
      roles: ['developer', 'qa'],
      requiresLogin: false,
    });
    expect(inspected.body).not.toContain('kata@acme.test');
  });

  it('creates a user, commits a human member with a unique normalized handle, logs in and consumes the link', async () => {
    const created = await invite();
    // Another member already has the desired handle.
    await h.app.projectman.domain.projects.update(
      'AR',
      { actor: { kind: 'human', handle: 'owner' }, author: ownerLogin },
      (draft) => {
        draft.team.members.push({
          kind: 'human',
          handle: 'kata',
          displayName: 'Bence',
          email: 'bence@acme.test',
          access: 'viewer',
          roles: [],
        });
        return 'Add fictional viewer';
      },
    );
    const accepted = await call('POST', `${publicPath(created)}/accept`, undefined, newAccount);
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json<Me>()).toMatchObject({
      name: 'Kata',
      email: 'kata@acme.test',
      handles: { AR: 'kata-2' },
    });
    expect(accepted.headers['set-cookie']).toContain('HttpOnly');
    expect(accepted.headers['set-cookie']).toContain('SameSite=Lax');
    const cookie = cookieOf(accepted);
    expect((await call('GET', '/api/me', cookie)).json().email).toBe('kata@acme.test');
    expect((await h.app.projectman.domain.projects.config('AR')).team.members.at(-1)).toEqual({
      kind: 'human',
      handle: 'kata-2',
      displayName: 'Kata',
      email: 'kata@acme.test',
      access: 'developer',
      roles: ['developer', 'qa'],
    });
    expect((await h.app.projectman.configStore.history('AR'))[0]).toMatchObject({
      message: 'Invite accepted: Kata',
      author: 'Kata',
    });
    expect(h.app.projectman.repos.invitations.get(created.id)?.acceptedAt).toBe(now.toISOString());
    const login = await call('POST', '/api/auth/login', undefined, {
      email: 'KATA@acme.test',
      password: newAccount.password,
    });
    expect(login.statusCode).toBe(200);
    expect((await call('GET', publicPath(created))).json().error.code).toBe('invite_invalid');
    expect((await call('POST', `${publicPath(created)}/accept`, cookie, {})).json().error.code).toBe(
      'invite_invalid',
    );
    const revokeUsed = await call('DELETE', `/api/projects/AR/invites/${created.id}`, owner);
    expect([revokeUsed.statusCode, revokeUsed.json().error.code]).toEqual([409, 'invite_used']);
  });

  it('requires the invited existing account, never changes its password and accepts an empty body', async () => {
    const account = await h.app.projectman.auth.prepareUser({ ...newAccount, email: invitation.email });
    h.app.projectman.repos.users.insert(account);
    const created = await invite();
    expect((await call('GET', publicPath(created))).json().requiresLogin).toBe(true);
    for (const cookie of [undefined, owner]) {
      const response = await call('POST', `${publicPath(created)}/accept`, cookie, newAccount);
      expect([response.statusCode, response.json().error.code]).toEqual([409, 'login_required']);
    }
    expect(h.app.projectman.repos.invitations.get(created.id)?.acceptedAt).toBeNull();
    const login = await call('POST', '/api/auth/login', undefined, {
      email: invitation.email,
      password: newAccount.password,
    });
    const accepted = await call('POST', `${publicPath(created)}/accept`, cookieOf(login), {});
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json().userId).toBe(account.id);
    expect(h.app.projectman.repos.users.count()).toBe(2);
    expect(h.app.projectman.repos.users.get(account.id)?.passwordHash).toBe(account.passwordHash);
  });

  it('allows only owners and admins to manage invites and only owners to offer admin access', async () => {
    const created = await invite({ ...invitation, access: 'admin' });
    const adminAccept = await call('POST', `${publicPath(created)}/accept`, undefined, newAccount);
    const admin = cookieOf(adminAccept);
    const inviteAdmin = await call('POST', '/api/projects/AR/invites', admin, {
      ...invitation,
      email: 'bence@acme.test',
      access: 'admin',
    });
    expect([inviteAdmin.statusCode, inviteAdmin.json().error.code]).toEqual([403, 'owner_only']);
    for (const access of ['developer', 'client', 'viewer']) {
      const input = { ...invitation, email: `${access}@acme.test`, access };
      const allowed = await invite(input, admin);
      expect((await call('GET', '/api/projects/AR/invites', admin)).statusCode).toBe(200);
      const accepted = await call('POST', `${publicPath(allowed)}/accept`, undefined, {
        name: 'Bence',
        password: newAccount.password,
      });
      const cookie = cookieOf(accepted);
      for (const [method, path, payload] of [
        ['GET', '/api/projects/AR/invites', undefined],
        ['POST', '/api/projects/AR/invites', invitation],
        ['DELETE', `/api/projects/AR/invites/${allowed.id}`, undefined],
      ] as const) {
        const forbidden = await call(method, path, cookie, payload);
        expect([forbidden.statusCode, forbidden.json().error.code]).toEqual([403, 'insufficient_access']);
      }
    }
    const pending = await invite({ ...invitation, email: 'pending@acme.test' });
    expect((await call('DELETE', `/api/projects/AR/invites/${pending.id}`, admin)).statusCode).toBe(204);
    for (const method of ['GET', 'POST', 'DELETE'] as const) {
      expect(
        (
          await call(
            method,
            method === 'DELETE' ? `/api/projects/AR/invites/${pending.id}` : '/api/projects/AR/invites',
          )
        ).statusCode,
      ).toBe(401);
    }
  });

  it('validates email, access, human roles, duplicate membership and registration password rules', async () => {
    for (const input of [
      { ...invitation, email: 'invalid' },
      { ...invitation, access: 'owner' },
    ]) {
      const response = await call('POST', '/api/projects/AR/invites', owner, input);
      expect([response.statusCode, response.json().error.code]).toEqual([400, 'invalid_request']);
    }
    for (const [roles, code] of [
      [['watchdog'], 'role_not_for_human'],
      [['unknown_role'], 'unknown_role'],
    ] as const) {
      const response = await call('POST', '/api/projects/AR/invites', owner, { ...invitation, roles });
      expect([response.statusCode, response.json().error.code]).toEqual([400, code]);
    }
    const duplicate = await call('POST', '/api/projects/AR/invites', owner, {
      ...invitation,
      email: ' OWNER@acme.test ',
    });
    expect([duplicate.statusCode, duplicate.json().error.code]).toEqual([409, 'already_member']);
    const created = await invite();
    for (const body of [
      {},
      { name: 'Kata', password: 'short' },
      { name: ' ', password: newAccount.password },
    ]) {
      const response = await call('POST', `${publicPath(created)}/accept`, undefined, body);
      expect([response.statusCode, response.json().error.code]).toEqual([400, 'invalid_request']);
    }
    expect(h.app.projectman.repos.users.count()).toBe(1);
  });

  it('accepts human custom roles and rejects roles removed while an invite is pending', async () => {
    await h.app.projectman.domain.projects.update(
      'AR',
      { actor: { kind: 'human', handle: 'owner' }, author: ownerLogin },
      (draft) => {
        draft.team.roles.push({
          id: 'client_tester',
          name: 'Acme tester',
          summary: 'Tests shared tasks.',
          notTheirJob: '',
          holders: 'human',
          instructions: '',
        });
        return 'Add test role';
      },
    );
    const created = await invite({ ...invitation, roles: ['client_tester'] });
    expect((await call('GET', publicPath(created))).json().roleNames).toEqual(['Acme tester']);
    await h.app.projectman.domain.projects.update(
      'AR',
      { actor: { kind: 'human', handle: 'owner' }, author: ownerLogin },
      (draft) => {
        draft.team.roles = [];
        return 'Remove test role';
      },
    );
    const accepted = await call('POST', `${publicPath(created)}/accept`, undefined, newAccount);
    expect([accepted.statusCode, accepted.json().error.code]).toEqual([400, 'unknown_role']);
    expect(h.app.projectman.repos.users.findByEmail(invitation.email)).toBeNull();
    expect(h.app.projectman.repos.invitations.get(created.id)?.acceptedAt).toBeNull();
  });

  it('rejects unknown, revoked and expired tokens at the exact expiry boundary', async () => {
    for (const method of ['GET', 'POST'] as const) {
      const response = await call(
        method,
        `/api/invites/unknown${method === 'POST' ? '/accept' : ''}`,
        undefined,
        newAccount,
      );
      expect([response.statusCode, response.json().error.code]).toEqual([404, 'invite_invalid']);
    }
    const revoked = await invite();
    expect((await call('DELETE', `/api/projects/AR/invites/${revoked.id}`, owner)).statusCode).toBe(204);
    expect((await call('DELETE', `/api/projects/AR/invites/${revoked.id}`, owner)).statusCode).toBe(204);
    const expired = await invite({ ...invitation, email: 'bence@acme.test' });
    now = new Date(expired.expiresAt);
    for (const created of [revoked, expired]) {
      for (const method of ['GET', 'POST'] as const) {
        const response = await call(
          method,
          `${publicPath(created)}${method === 'POST' ? '/accept' : ''}`,
          undefined,
          newAccount,
        );
        expect([response.statusCode, response.json().error.code]).toEqual([404, 'invite_invalid']);
      }
    }
    expect((await call('DELETE', '/api/projects/AR/invites/unknown', owner)).statusCode).toBe(404);
    expect(h.app.projectman.repos.users.count()).toBe(1);
  });

  it('consumes a token once even with simultaneous acceptance requests', async () => {
    const created = await invite();
    const responses = await Promise.all(
      [1, 2].map(() => call('POST', `${publicPath(created)}/accept`, undefined, newAccount)),
    );
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 404]);
    expect(h.app.projectman.repos.users.count()).toBe(2);
    expect(
      (await h.app.projectman.domain.projects.config('AR')).team.members.filter(
        (member) => member.kind === 'human' && member.email === invitation.email,
      ),
    ).toHaveLength(1);
  });

  it('leaves the invite reusable and creates no account when the config commit fails', async () => {
    const created = await invite();
    vi.spyOn(h.app.projectman.configStore, 'save').mockRejectedValueOnce(new Error('fictional disk failure'));
    const failed = await call('POST', `${publicPath(created)}/accept`, undefined, newAccount);
    expect(failed.statusCode).toBe(500);
    expect(h.app.projectman.repos.invitations.get(created.id)?.acceptedAt).toBeNull();
    expect(h.app.projectman.repos.users.findByEmail(invitation.email)).toBeNull();
    expect((await call('POST', `${publicPath(created)}/accept`, undefined, newAccount)).statusCode).toBe(200);
  });

  it('rate-limits public inspection and acceptance like login', async () => {
    for (let attempt = 0; attempt < 10; attempt++)
      expect((await call('GET', '/api/invites/unknown')).statusCode).toBe(404);
    for (const method of ['GET', 'POST'] as const) {
      const response = await call(
        method,
        `/api/invites/unknown${method === 'POST' ? '/accept' : ''}`,
        undefined,
        newAccount,
      );
      expect([response.statusCode, response.json().error.code]).toEqual([429, 'too_many_attempts']);
    }
  });
});
