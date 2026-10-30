import { createHmac, timingSafeEqual } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmailLoginVerifyRequest } from '@projectman/shared';
import { createRepositories, openDatabase } from '../../db';
import type { EmailLoginCodeRecord, Repositories } from '../../db';
import type { EmailCodeMailInput, EmailLoginDirectory } from '../../contracts';
import { createEmailLoginService } from './index';
import type { EmailLoginService } from './index';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    createHmac: vi.fn(actual.createHmac),
    timingSafeEqual: vi.fn(actual.timingSafeEqual),
  };
});

describe('purpose-bound e-mail codes (PM-946)', () => {
  const key = Buffer.alloc(32, 9);
  const email = 'client@example.test';
  const code = '123456';
  const account = {
    eligible: true as const,
    userId: 'usr_client',
    clientProjects: 1,
    openClientInvites: 0,
    inviteDisplayName: null,
  };
  let repos: Repositories;
  let service: EmailLoginService;
  let now: Date;
  let standing: Awaited<ReturnType<EmailLoginDirectory['standing']>>;
  const sent: EmailCodeMailInput[] = [];

  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
    now = new Date('2026-10-19T12:00:00.000Z');
    standing = account;
    sent.length = 0;
    service = createEmailLoginService({
      repo: repos.emailLogin,
      directory: {
        inviteEmail: () => null,
        standing: async () => standing,
        acceptOpenClientInvites: async () => ({ userId: null, accepted: 0 }),
      },
      mailer: { send: async (input) => void sent.push(input) },
      key,
      now: () => now,
      logger: { info: () => undefined, warn: () => undefined },
      generateCode: () => code,
    });
  });

  afterEach(async () => {
    await service.stop();
    repos.db.close();
  });

  const request = async (purpose: 'login' | 'password') => {
    service.requestCode({ email }, '203.0.113.1', purpose);
    await service.settled();
  };

  it('mails a password code only to an existing client account', async () => {
    standing = { ...account, userId: null, clientProjects: 0, openClientInvites: 1 };
    await request('password');
    expect(sent).toHaveLength(0);
    // The same address does get a login code: the invitation is enough for that.
    await request('login');
    expect(sent.map((s) => s.purpose)).toEqual(['login']);

    now = new Date(now.getTime() + 2 * 60_000);
    standing = account;
    await request('password');
    expect(sent.map((s) => s.purpose)).toEqual(['login', 'password']);
  });

  it('redeems a code only for the purpose it was made for', async () => {
    await request('login');
    await expect(service.redeemPasswordCode({ email, code }, '203.0.113.1')).rejects.toMatchObject({
      code: 'email_code_invalid',
    });
    await expect(service.verify({ email, code }, '203.0.113.1')).resolves.toEqual({ userId: 'usr_client' });

    now = new Date(now.getTime() + 2 * 60_000);
    await request('password');
    await expect(service.verify({ email, code }, '203.0.113.1')).rejects.toMatchObject({
      code: 'email_code_invalid',
    });
    await expect(service.redeemPasswordCode({ email, code }, '203.0.113.1')).resolves.toEqual({
      userId: 'usr_client',
    });
  });
});

describe('invalid e-mail code verification work (PM-703)', () => {
  const key = Buffer.alloc(32, 7);
  const at = '2026-10-19T12:00:00.000Z';
  const email = 'client@example.test';
  const code = '123456';
  const mac = (label: string, value: string) =>
    createHmac('sha256', key).update(`${label}:${value}`).digest('hex');
  let repos: Repositories;
  let service: EmailLoginService;
  const directory = {
    inviteEmail: vi.fn((_token: string): string | null => null),
    standing: vi.fn(async () => ({ eligible: false as const })),
    acceptOpenClientInvites: vi.fn(async () => ({ userId: null, accepted: 0 })),
  };

  const build = () =>
    createEmailLoginService({
      repo: repos.emailLogin,
      directory,
      mailer: { send: async () => undefined },
      key,
      now: () => new Date(at),
      logger: { info: () => undefined, warn: () => undefined },
    });

  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
    service = build();
  });

  afterEach(async () => {
    await service.stop();
    repos.db.close();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  const totalChanges = () => (repos.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;

  it.each(['wrong', 'missing', 'used', 'expired', 'exhausted', 'unknown-token'])(
    'performs the same HMAC, comparison, reads and real writes for %s',
    async (state) => {
      const stored: EmailLoginCodeRecord = {
        addressHash: mac('address', email),
        id: 'elc_test',
        codeHash: mac('code', `elc_test:${code}`),
        createdAt: at,
        expiresAt: '2026-10-19T12:10:00.000Z',
        failedAttempts: state === 'exhausted' ? 5 : 0,
        usedAt: state === 'used' ? at : null,
      };
      if (state === 'expired') stored.expiresAt = at;
      if (state !== 'missing' && state !== 'unknown-token') repos.emailLogin.putCode(stored);
      const input: EmailLoginVerifyRequest =
        state === 'unknown-token'
          ? { inviteToken: 'unknown-token', code }
          : { email, code: state === 'wrong' ? '654321' : code };
      const read = vi.spyOn(repos.emailLogin, 'code');
      const fail = vi.spyOn(repos.emailLogin, 'failAttempt');
      const event = vi.spyOn(repos.emailLogin, 'addEvent');
      vi.clearAllMocks();
      const before = totalChanges();

      await expect(service.verify(input, '203.0.113.1')).rejects.toMatchObject({
        code: 'email_code_invalid',
        status: 400,
        message: 'the code is wrong, expired or already used',
      });

      // IP, address, then code HMAC; one fixed-size constant-time comparison in every case.
      expect(createHmac).toHaveBeenCalledTimes(3);
      expect(timingSafeEqual).toHaveBeenCalledTimes(1);
      const [expected, given] = vi.mocked(timingSafeEqual).mock.calls[0]!;
      expect(expected.byteLength).toBe(32);
      expect(given.byteLength).toBe(32);
      expect(read).toHaveBeenCalledTimes(1);
      expect(event).toHaveBeenCalledExactlyOnceWith('verify', expect.any(String), at);
      expect(fail).toHaveBeenCalledTimes(1);
      // The counted event and a real row update: a no-op UPDATE cannot satisfy this assertion.
      expect(totalChanges() - before).toBe(2);
      expect(directory.standing).not.toHaveBeenCalled();
      expect(directory.acceptOpenClientInvites).not.toHaveBeenCalled();
      if (state === 'wrong') {
        expect(fail).toHaveBeenCalledWith(stored.id);
        expect(repos.emailLogin.code(stored.addressHash)?.failedAttempts).toBe(1);
      } else {
        expect(fail).not.toHaveBeenCalledWith(stored.id);
        expect(repos.emailLogin.code(stored.addressHash)).toEqual(
          state === 'missing' || state === 'unknown-token' ? null : stored,
        );
      }
    },
  );

  it('keeps the invalid-code write effective after pruning and restarting the service', async () => {
    const verifyWrite = async () => {
      const before = totalChanges();
      await expect(service.verify({ email, code }, '203.0.113.1')).rejects.toMatchObject({
        code: 'email_code_invalid',
      });
      expect(totalChanges() - before).toBe(2);
    };
    await verifyWrite();
    // A much later request prunes old codes and events, including rows left by older builds.
    repos.emailLogin.prune('2027-10-19T12:00:00.000Z');
    await verifyWrite();
    await service.stop();
    service = build();
    await verifyWrite();
    for (let i = 0; i < 5; i += 1) {
      await expect(
        service.verify({ email: `unknown${i}@example.test`, code }, '203.0.113.1'),
      ).rejects.toMatchObject({ code: 'email_code_invalid' });
    }
    // Padding must not create an unbounded set of codes for attacker-controlled addresses.
    expect(
      (repos.db.prepare('SELECT COUNT(*) AS n FROM email_login_codes').get() as { n: number }).n,
    ).toBeLessThanOrEqual(1);
  });

  it.each(['email', 'inviteToken'])(
    'never redeems the dummy row through %s, even if its comparison matches',
    async (path) => {
      const { addressHash } = repos.db
        .prepare('SELECT address_hash AS addressHash FROM email_login_codes')
        .get() as { addressHash: string };
      const dummy = repos.emailLogin.code(addressHash)!;
      expect(addressHash).not.toMatch(/^[a-f0-9]{64}$/);
      expect(dummy.usedAt).not.toBeNull();
      expect(dummy.failedAttempts).toBeGreaterThanOrEqual(5);
      expect(repos.emailLogin.consume(dummy.id, at)).toBe(false);

      // Even an accidental lookup of the reserved row with reset flags must fail closed.
      vi.spyOn(repos.emailLogin, 'code').mockReturnValue({
        ...dummy,
        usedAt: null,
        failedAttempts: 0,
      });
      if (path === 'inviteToken') directory.inviteEmail.mockReturnValueOnce(email);
      vi.mocked(timingSafeEqual).mockReturnValueOnce(true);
      const input = path === 'email' ? { email, code } : { inviteToken: 'client-invite', code };
      await expect(service.verify(input, '203.0.113.1')).rejects.toMatchObject({
        code: 'email_code_invalid',
        status: 400,
      });
      expect(directory.standing).not.toHaveBeenCalled();
      expect(directory.acceptOpenClientInvites).not.toHaveBeenCalled();
    },
  );
});
