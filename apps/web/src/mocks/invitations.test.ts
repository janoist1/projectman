import { describe, expect, it } from 'vitest';
import type { CreatedInvitation } from '@projectman/shared';
import { MockBackend } from './backend';
import { inviteTokenHash } from './inviteTokens';

const input = { email: 'colleague@acme.test', displayName: 'Kata', access: 'developer', roles: ['qa'] };
function created(backend: MockBackend, body = input) {
  const response = backend.handle('POST', '/api/projects/AC/invites', body);
  expect(response.status).toBe(201);
  return response.body as CreatedInvitation;
}
const publicPath = (invite: CreatedInvitation) => invite.path.replace('/invite/', '/api/invites/');
const code = (response: { body?: unknown }) => (response.body as { error: { code: string } }).error.code;

describe('mock invitations', () => {
  it('uses SHA-256 compatible with the server', () => {
    expect(inviteTokenHash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('creates, inspects, accepts, logs in and consumes invitations', () => {
    const backend = new MockBackend();
    const invite = created(backend);
    expect(backend.invitations[0]?.tokenHash).toBe(inviteTokenHash(invite.path.split('/').at(-1)!));
    const list = backend.handle('GET', '/api/projects/AC/invites', undefined);
    expect(JSON.stringify(list.body)).not.toContain(invite.path.split('/').at(-1)!);
    expect(JSON.stringify(list.body)).not.toContain('tokenHash');
    backend.auth = 'login';
    expect(backend.handle('GET', publicPath(invite), undefined).body).toMatchObject({
      projectName: 'Acme webshop',
      access: 'developer',
      roles: ['qa'],
    });
    const accepted = backend.handle('POST', `${publicPath(invite)}/accept`, {
      name: 'Kata',
      password: 'correct horse battery',
    });
    expect(accepted.status).toBe(200);
    expect(backend.auth).toBe('ready');
    expect(backend.history[0]?.message).toBe('Invite accepted: Kata');
    expect(backend.config.team.members.at(-1)).toMatchObject({
      handle: 'kata-2',
      email: input.email,
      access: 'developer',
    });
    expect(code(backend.handle('GET', publicPath(invite), undefined))).toBe('invite_invalid');
    expect(code(backend.handle('POST', `${publicPath(invite)}/accept`, {}))).toBe('invite_invalid');
  });
  it('enforces admin permissions, owner-only grants, human roles and existing membership', () => {
    const backend = new MockBackend();
    expect(
      code(backend.handle('POST', '/api/projects/AC/invites', { ...input, email: 'OWNER@acme.test' })),
    ).toBe('already_member');
    expect(code(backend.handle('POST', '/api/projects/AC/invites', { ...input, access: 'owner' }))).toBe(
      'invalid_request',
    );
    expect(code(backend.handle('POST', '/api/projects/AC/invites', { ...input, roles: ['watchdog'] }))).toBe(
      'role_not_for_human',
    );
    expect(
      code(backend.handle('POST', '/api/projects/AC/invites', { ...input, roles: ['unknown_role'] })),
    ).toBe('unknown_role');
    backend.members.find((member) => member.handle === 'owner')!.role = 'admin';
    expect(code(backend.handle('POST', '/api/projects/AC/invites', { ...input, access: 'admin' }))).toBe(
      'owner_only',
    );
    expect(created(backend, { ...input, access: 'viewer' }).access).toBe('viewer');
    backend.members.find((member) => member.handle === 'owner')!.role = 'developer';
    for (const method of ['GET', 'POST', 'DELETE'])
      expect(backend.handle(method, '/api/projects/AC/invites', input).status).toBe(403);
  });
  it('requires the correct existing account and validates new account passwords', () => {
    const backend = new MockBackend();
    backend.accounts.set(input.email, {
      userId: 'usr_kata',
      name: 'Kata',
      email: input.email,
      password: 'correct horse battery',
    });
    const invite = created(backend);
    expect(code(backend.handle('POST', `${publicPath(invite)}/accept`, {}))).toBe('login_required');
    backend.auth = 'login';
    expect(code(backend.handle('POST', `${publicPath(invite)}/accept`, {}))).toBe('login_required');
    expect(
      backend.handle('POST', '/api/auth/login', { email: input.email, password: 'correct horse battery' })
        .status,
    ).toBe(200);
    expect(backend.handle('POST', `${publicPath(invite)}/accept`, {}).status).toBe(200);
    const fresh = new MockBackend();
    const newInvite = created(fresh);
    expect(
      code(fresh.handle('POST', `${publicPath(newInvite)}/accept`, { name: 'Kata', password: 'short' })),
    ).toBe('invalid_request');
  });
  it('rejects unknown, revoked, expired and used links and rate-limits public endpoints', () => {
    for (const state of ['unknown', 'revoked', 'expired', 'used']) {
      const backend = new MockBackend();
      const invite = created(backend);
      if (state === 'revoked')
        expect(backend.handle('DELETE', `/api/projects/AC/invites/${invite.id}`, undefined).status).toBe(204);
      if (state === 'expired') backend.invitations[0]!.expiresAt = new Date(Date.now() - 1).toISOString();
      if (state === 'used') backend.invitations[0]!.acceptedAt = new Date().toISOString();
      const path = state === 'unknown' ? '/api/invites/unknown' : publicPath(invite);
      expect(code(backend.handle('GET', path, undefined))).toBe('invite_invalid');
      expect(
        code(backend.handle('POST', `${path}/accept`, { name: 'Kata', password: 'correct horse battery' })),
      ).toBe('invite_invalid');
    }
    const backend = new MockBackend();
    for (let i = 0; i < 10; i++) backend.handle('GET', '/api/invites/unknown', undefined);
    expect(backend.handle('GET', '/api/invites/unknown', undefined).status).toBe(429);
    expect(backend.handle('POST', '/api/invites/unknown/accept', {}).status).toBe(429);
  });
});
