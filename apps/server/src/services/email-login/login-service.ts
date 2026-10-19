import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import type { EmailLoginCodeRequest, EmailLoginVerifyRequest } from '@projectman/shared';
import { EMAIL_LOGIN_MAX_FAILED_ATTEMPTS } from '../../db';
import type { EmailLoginEventKind, Repositories } from '../../db';
import { EMAIL_CODE_DELIVERY_FAILED } from '../../contracts';
import type { EmailCodeMailer, EmailLoginDirectory } from '../../contracts';
import { DomainError, invalid, ipRateLimitKey, KeyedMutex, newId } from '../../kernel';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** The durable limits of the e-mail login (PM-670); the windows slide, the counts live in the database. */
export const EMAIL_LOGIN_LIMITS = {
  codeTtlMs: 10 * MINUTE_MS,
  /** A new code for the same address at most this often. */
  resendMs: MINUTE_MS,
  perAddressHour: 5,
  perAddressDay: 10,
  requestsPerIpHour: 20,
  /** Letters sent in a day, all addresses together (the SES cost and reputation). */
  sendsPerDay: 200,
  verifiesPerIpHour: 30,
  /** Code requests waiting for their background step; more are dropped quietly. */
  maxQueued: 200,
} as const;

/** The constant answer of a code request. */
export const EMAIL_LOGIN_CODE_REQUESTED = { expiresInSeconds: 600, resendAfterSeconds: 60 } as const;

export interface EmailLoginService {
  /**
   * Takes a code request and answers at once, the same for every address. Only the IP and the global
   * limits are looked at here (they may refuse the request, never an address); eligibility, the address
   * limits, the code and the letter follow in the background, one request at a time.
   */
  requestCode(input: EmailLoginCodeRequest, clientIp: string): typeof EMAIL_LOGIN_CODE_REQUESTED;
  /** Redeems a code; the account and its client memberships exist when it returns. */
  verify(input: EmailLoginVerifyRequest, clientIp: string): Promise<{ userId: string }>;
  /** The background steps queued so far have run. */
  settled(): Promise<void>;
  stop(): Promise<void>;
}

type LoginLogger = { info(obj: object, msg?: string): void; warn(obj: object, msg?: string): void };

const invalidCode = () => invalid('email_code_invalid', 'the code is wrong, expired or already used');

/** Hex HMAC-SHA-256 of a labelled value: the one way an address, an IP or a code is stored or compared. */
function mac(key: Buffer, label: string, value: string): string {
  return createHmac('sha256', key).update(`${label}:${value}`).digest('hex');
}

const normalizeAddress = (email: string) => email.trim().toLowerCase();

export function createEmailLoginService(deps: {
  repo: Repositories['emailLogin'];
  directory: EmailLoginDirectory;
  mailer: EmailCodeMailer;
  key: Buffer;
  now: () => Date;
  logger: LoginLogger;
  generateCode?: () => string;
}): EmailLoginService {
  const { repo, directory, mailer, key, now, logger } = deps;
  const L = EMAIL_LOGIN_LIMITS;
  const generateCode = deps.generateCode ?? (() => randomInt(0, 1_000_000).toString().padStart(6, '0'));
  const verifyLock = new KeyedMutex();
  let tail: Promise<void> = Promise.resolve();
  let queued = 0;
  let stopped = false;

  const since = (ms: number) => new Date(now().getTime() - ms).toISOString();
  const addressHash = (address: string) => mac(key, 'address', address);
  const ipSubject = (ip: string) => `ip:${mac(key, 'ip', ipRateLimitKey(ip))}`;

  /** Seconds until the oldest event in the window leaves it, at least 1. */
  function retryAfter(kind: EmailLoginEventKind, subject: string | null, windowMs: number): number {
    const oldest = repo.oldestEvent(kind, subject, since(windowMs));
    const waitMs = oldest === null ? windowMs : Date.parse(oldest) + windowMs - now().getTime();
    return Math.max(1, Math.ceil(waitMs / 1000));
  }

  function enforce(kind: EmailLoginEventKind, subject: string | null, windowMs: number, max: number): void {
    if (repo.countEvents(kind, subject, since(windowMs)) < max) return;
    throw new DomainError('email_login_rate_limited', 'too many login attempts; try again later', {
      status: 429,
      details: { retryAfterSeconds: retryAfter(kind, subject, windowMs) },
    });
  }

  /** The background step of one code request. It never throws, and logs only fixed codes. */
  async function issue(input: EmailLoginCodeRequest): Promise<void> {
    const email = 'email' in input ? input.email : directory.inviteEmail(input.inviteToken);
    if (!email) return;
    const address = normalizeAddress(email);
    if (!(await directory.standing(address)).eligible) return;
    const hash = addressHash(address);
    const subject = `addr:${hash}`;
    const at = now();
    // The limits of the address and the global one are checked again here: they may have filled while queued.
    if (
      repo.countEvents('send', subject, since(L.resendMs)) > 0 ||
      repo.countEvents('send', subject, since(HOUR_MS)) >= L.perAddressHour ||
      repo.countEvents('send', subject, since(DAY_MS)) >= L.perAddressDay ||
      repo.countEvents('send', null, since(DAY_MS)) >= L.sendsPerDay
    )
      return;
    const code = generateCode();
    const id = newId('elc');
    const expiresAt = new Date(at.getTime() + L.codeTtlMs).toISOString();
    repo.putCode({
      addressHash: hash,
      id,
      codeHash: mac(key, 'code', `${id}:${code}`),
      createdAt: at.toISOString(),
      expiresAt,
      failedAttempts: 0,
      usedAt: null,
    });
    repo.addEvent('send', subject, at.toISOString());
    try {
      await mailer.send({ to: address, code, expiresAt });
    } catch (err) {
      // Only the code and the coarse reason: the error object carries the address.
      const reason = (err as { reason?: unknown } | null)?.reason;
      logger.warn(
        { code: EMAIL_CODE_DELIVERY_FAILED, reason: typeof reason === 'string' ? reason : 'unavailable' },
        'login code not delivered',
      );
    }
  }

  return {
    requestCode(input, clientIp) {
      const subject = ipSubject(clientIp);
      enforce('request', subject, HOUR_MS, L.requestsPerIpHour);
      enforce('send', null, DAY_MS, L.sendsPerDay);
      repo.addEvent('request', subject, now().toISOString());
      repo.prune(since(DAY_MS));
      if (stopped || queued >= L.maxQueued) return EMAIL_LOGIN_CODE_REQUESTED;
      queued += 1;
      tail = tail
        .then(() => (stopped ? undefined : issue(input)))
        .catch((err: unknown) => {
          logger.warn(
            { code: 'email_login_request_failed', name: (err as Error)?.name },
            'code request failed',
          );
        })
        .finally(() => {
          queued -= 1;
        });
      return EMAIL_LOGIN_CODE_REQUESTED;
    },

    async verify(input, clientIp) {
      const subject = ipSubject(clientIp);
      enforce('verify', subject, HOUR_MS, L.verifiesPerIpHour);
      repo.addEvent('verify', subject, now().toISOString());
      const email = 'email' in input ? input.email : directory.inviteEmail(input.inviteToken);
      if (!email) throw invalidCode();
      const address = normalizeAddress(email);
      const hash = addressHash(address);
      return verifyLock.run(hash, async () => {
        const at = now().toISOString();
        const stored = repo.code(hash);
        if (
          !stored ||
          stored.usedAt !== null ||
          stored.expiresAt <= at ||
          stored.failedAttempts >= EMAIL_LOGIN_MAX_FAILED_ATTEMPTS
        )
          throw invalidCode();
        const expected = Buffer.from(stored.codeHash, 'hex');
        const given = Buffer.from(mac(key, 'code', `${stored.id}:${input.code}`), 'hex');
        if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
          repo.failAttempt(stored.id);
          throw invalidCode();
        }
        const noAccess = () =>
          new DomainError('email_login_no_access', 'this address has no access to log in', { status: 403 });
        const before = await directory.standing(address);
        if (!before.eligible) {
          repo.consume(stored.id, at);
          throw noAccess();
        }
        const name = before.userId === null ? (input.name ?? before.inviteDisplayName) : null;
        if (before.userId === null && !name)
          throw invalid('email_login_name_required', 'a name is needed for the new account');
        if (!repo.consume(stored.id, at)) throw invalidCode();
        const { accepted } = await directory.acceptOpenClientInvites(address, name);
        const after = await directory.standing(address);
        if (!after.eligible || after.userId === null || after.clientProjects < 1) throw noAccess();
        logger.info({ accepted }, 'client logged in with an e-mail code');
        return { userId: after.userId };
      });
    },

    settled: () => tail,

    async stop() {
      stopped = true;
      await tail;
    },
  };
}
