import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreatedInvitation } from '@projectman/shared';
import { MockBackend } from './backend';

const address = 'kata@client.test';

function invite(
  backend: MockBackend,
  access = 'client',
  email = address,
  displayName: string | undefined = 'Kata',
): CreatedInvitation {
  return backend.handle('POST', '/api/projects/AC/invites', {
    email,
    ...(displayName ? { displayName } : {}),
    access,
    roles: [],
  }).body as CreatedInvitation;
}

function request(backend: MockBackend, body: unknown) {
  return backend.handle('POST', '/api/auth/email/request', body);
}
function verify(backend: MockBackend, body: unknown) {
  return backend.handle('POST', '/api/auth/email/verify', body);
}
function errorCode(response: { body?: unknown }) {
  return (response.body as { error: { code: string } }).error.code;
}

describe('MockEmailLogin', () => {
  let backend: MockBackend;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    backend = new MockBackend();
    backend.emailLogin.enabled = true;
  });
  afterEach(() => vi.useRealTimers());

  it('is unavailable until enabled, and the setup status says so only then', () => {
    const off = new MockBackend('login');
    expect(request(off, { email: address }).status).toBe(503);
    expect(verify(off, { email: address, code: '123456' }).status).toBe(503);
    expect(off.handle('GET', '/api/setup', undefined).body).toEqual({ needsSetup: false });
    expect(backend.handle('GET', '/api/setup', undefined).body).toEqual({
      needsSetup: false,
      emailLoginEnabled: true,
    });
  });

  it('answers the same for an eligible and an unknown address, and sends a code only to the first', () => {
    invite(backend);
    const known = request(backend, { email: address });
    const unknown = request(backend, { email: 'nobody@client.test' });
    expect(known).toEqual({ status: 202, body: { expiresInSeconds: 600, resendAfterSeconds: 60 } });
    expect(unknown).toEqual(known);
    expect(backend.emailLogin.outbox.map((mail) => mail.email)).toEqual([address]);
  });

  it('refuses an address that is not a client', () => {
    invite(backend, 'developer');
    request(backend, { email: address });
    // The host owner may log in with a password only.
    request(backend, { email: backend.user.email });
    expect(backend.emailLogin.outbox).toHaveLength(0);
  });

  it('keeps the mail back within a minute and issues a new code after it, which replaces the old one', () => {
    invite(backend);
    request(backend, { email: address });
    request(backend, { email: address });
    expect(backend.emailLogin.outbox).toHaveLength(1);
    vi.advanceTimersByTime(60_000);
    request(backend, { email: address });
    const [first, second] = backend.emailLogin.outbox.map((mail) => mail.code);
    expect(second).not.toBe(first);
    expect(errorCode(verify(backend, { email: address, code: first }))).toBe('email_code_invalid');
  });

  it('accepts a code by the invitation token, with the name of the invitation', () => {
    const created = invite(backend);
    const token = created.path.replace('/invite/', '');
    request(backend, { inviteToken: token });
    const code = backend.emailLogin.lastCodeTo(address)!;
    const response = verify(backend, { inviteToken: token, code });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ email: address, name: 'Kata' });
    expect(backend.auth).toBe('ready');
    expect(backend.accounts.get(address)?.password).toBeNull();
    expect(backend.invitations[0]!.acceptedAt).not.toBeNull();
  });

  it('asks for a name when the new account has none, and keeps the code for it', () => {
    invite(backend, 'client', address, '');
    request(backend, { email: address });
    const code = backend.emailLogin.lastCodeTo(address)!;
    expect(errorCode(verify(backend, { email: address, code }))).toBe('email_login_name_required');
    expect(verify(backend, { email: address, code, name: 'Kata' }).status).toBe(200);
  });

  it('counts wrong tries and stops after five, even for the right code', () => {
    invite(backend);
    request(backend, { email: address });
    const code = backend.emailLogin.lastCodeTo(address)!;
    for (let i = 0; i < 5; i += 1)
      expect(errorCode(verify(backend, { email: address, code: '000000' }))).toBe('email_code_invalid');
    expect(errorCode(verify(backend, { email: address, code }))).toBe('email_code_invalid');
  });

  it('lets a code live ten minutes and use it once', () => {
    invite(backend);
    request(backend, { email: address });
    const code = backend.emailLogin.lastCodeTo(address)!;
    vi.advanceTimersByTime(600_000);
    expect(errorCode(verify(backend, { email: address, code }))).toBe('email_code_invalid');
    request(backend, { email: address });
    const fresh = backend.emailLogin.lastCodeTo(address)!;
    expect(verify(backend, { email: address, code: fresh }).status).toBe(200);
    expect(errorCode(verify(backend, { email: address, code: fresh }))).toBe('email_code_invalid');
  });

  it('spends a right code of an address that lost its access', () => {
    invite(backend);
    request(backend, { email: address });
    const code = backend.emailLogin.lastCodeTo(address)!;
    backend.invitations[0]!.revokedAt = new Date().toISOString();
    expect(errorCode(verify(backend, { email: address, code }))).toBe('email_login_no_access');
    expect(errorCode(verify(backend, { email: address, code }))).toBe('email_code_invalid');
  });

  it('answers a rate limit with the seconds to wait', () => {
    backend.emailLogin.rateLimitedFor = 42;
    const response = request(backend, { email: address });
    expect(response.status).toBe(429);
    expect(response.body).toMatchObject({
      error: { code: 'email_login_rate_limited', details: { retryAfterSeconds: 42 } },
    });
  });

  it('rejects a malformed body as an invalid request', () => {
    expect(errorCode(request(backend, {}))).toBe('invalid_request');
    expect(errorCode(verify(backend, { email: address, code: '12' }))).toBe('invalid_request');
  });

  it('shows an invitation hint only for a client invitation and only when enabled', () => {
    const client = invite(backend).path.replace('/invite/', '');
    const member = invite(backend, 'developer', 'lajos@client.test').path.replace('/invite/', '');
    expect(backend.handle('GET', `/api/invites/${client}`, undefined).body).toHaveProperty('emailHint');
    expect(backend.handle('GET', `/api/invites/${member}`, undefined).body).not.toHaveProperty('emailHint');
    backend.emailLogin.enabled = false;
    expect(backend.handle('GET', `/api/invites/${client}`, undefined).body).not.toHaveProperty('emailHint');
  });

  it('does not let a passwordless account log in with a password', () => {
    const token = invite(backend).path.replace('/invite/', '');
    request(backend, { inviteToken: token });
    verify(backend, { inviteToken: token, code: backend.emailLogin.lastCodeTo(address)! });
    backend.handle('POST', '/api/auth/logout', undefined);
    const login = backend.handle('POST', '/api/auth/login', { email: address, password: 'anything at all' });
    expect(login.status).toBe(401);
  });
});
