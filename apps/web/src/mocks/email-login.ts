import {
  EmailLoginCodeRequest,
  EmailLoginVerifyRequest,
  EMAIL_LOGIN_CODE_LENGTH,
  PasswordCodeRequest,
  PasswordResetRequest,
} from '@projectman/shared';
import type { ErrorCode } from '@projectman/shared';

export interface EmailLoginResponse {
  status: number;
  body?: unknown;
}

/** What the e-mail login needs of the fake backend (the backend implements it). */
export interface EmailLoginHost {
  /** The address of an open client invitation by its token; null for any other token. */
  inviteEmail(token: string): string | null;
  /** Whether the address may log in with a code: a client account or an open client invitation, nothing more. */
  eligible(email: string): boolean;
  /** Whether the address has an account already. */
  hasAccount(email: string): boolean;
  /** Whether the address is a client with an account and a client seat: the only one a password code serves. */
  hasClientAccount(email: string): boolean;
  /** Sets the password of the account and starts its session. */
  setPassword(email: string, password: string): unknown;
  /** The display name an open client invitation of the address carries. */
  inviteDisplayName(email: string): string | null;
  /** Accepts the open client invitations of the address, creates the account when needed and starts the session. */
  startSession(email: string, name: string | null): unknown;
}

/** What a code is for: a login code logs in, a password code sets a password (PM-946). */
type CodePurpose = 'login' | 'password';

interface IssuedCode {
  code: string;
  purpose: CodePurpose;
  sentAt: number;
  expiresAt: number;
  failed: number;
  used: boolean;
}

/** The server's code rules (PM-670): ten minutes, five wrong tries, a new code in a minute. */
export const CODE_LIFETIME_MS = 600_000;
export const RESEND_AFTER_MS = 60_000;
export const MAX_FAILED_ATTEMPTS = 5;

function failure(status: number, code: ErrorCode, message: string, details?: unknown): EmailLoginResponse {
  return { status, body: { error: { code, message, ...(details === undefined ? {} : { details }) } } };
}

/**
 * The fake of the e-mail code login: it issues, keeps and checks the codes the way the server does, and
 * lists every mail it "sent" in `outbox`. Off until a test or a scenario sets `enabled`.
 */
export class MockEmailLogin {
  /** Whether the server has the login (a mailer); off, the setup status does not say so and the routes answer 503. */
  enabled = false;
  /** While set, both routes answer `email_login_rate_limited` with this many seconds to wait. */
  rateLimitedFor: number | null = null;
  /** Every code mail, in the order sent; a test reads the code from here. */
  readonly outbox: Array<{ email: string; code: string; purpose: CodePurpose; sentAt: number }> = [];
  private readonly codes = new Map<string, IssuedCode>();
  private nextCode = 123_456;

  private readonly host: EmailLoginHost;

  constructor(host: EmailLoginHost) {
    this.host = host;
  }

  /** The last code mailed to the address. */
  lastCodeTo(email: string): string | undefined {
    return this.outbox.findLast((mail) => mail.email === email.trim().toLowerCase())?.code;
  }

  /** A code request; `password` asks for a code that sets a password, and only an existing client account gets one. */
  request(body: unknown, purpose: CodePurpose = 'login'): EmailLoginResponse {
    if (!this.enabled) return failure(503, 'email_login_unavailable', 'E-mail login is not available');
    const input =
      purpose === 'password' ? PasswordCodeRequest.safeParse(body) : EmailLoginCodeRequest.safeParse(body);
    if (!input.success) return failure(400, 'invalid_request', 'Invalid request');
    if (this.rateLimitedFor !== null) return this.limited(this.rateLimitedFor);
    const address =
      'email' in input.data
        ? input.data.email.trim().toLowerCase()
        : this.host.inviteEmail(input.data.inviteToken);
    const accepted = { status: 202, body: { expiresInSeconds: 600, resendAfterSeconds: 60 } };
    if (!address) return accepted;
    const now = Date.now();
    const previous = this.codes.get(address);
    // Within the minute the answer is the same and no new mail goes: nobody learns anything from the timing.
    if (previous && !previous.used && now - previous.sentAt < RESEND_AFTER_MS) return accepted;
    if (!(purpose === 'password' ? this.host.hasClientAccount(address) : this.host.eligible(address)))
      return accepted;
    const code = String(this.nextCode++).padStart(EMAIL_LOGIN_CODE_LENGTH, '0');
    // One live code per address: a new one of either purpose replaces the earlier one.
    this.codes.set(address, {
      code,
      purpose,
      sentAt: now,
      expiresAt: now + CODE_LIFETIME_MS,
      failed: 0,
      used: false,
    });
    this.outbox.push({ email: address, code, purpose, sentAt: now });
    return accepted;
  }

  verify(body: unknown): EmailLoginResponse {
    if (!this.enabled) return failure(503, 'email_login_unavailable', 'E-mail login is not available');
    const input = EmailLoginVerifyRequest.safeParse(body);
    if (!input.success) return failure(400, 'invalid_request', 'Invalid request');
    if (this.rateLimitedFor !== null) return this.limited(this.rateLimitedFor);
    const address =
      'email' in input.data
        ? input.data.email.trim().toLowerCase()
        : this.host.inviteEmail(input.data.inviteToken);
    const issued = this.liveCode(address, 'login', input.data.code);
    if ('response' in issued) return issued.response;
    // A right code of an address that may not log in is spent all the same.
    if (!this.host.eligible(issued.address)) {
      issued.code.used = true;
      return failure(403, 'email_login_no_access', 'This address may not log in with a code');
    }
    let name: string | null = null;
    if (!this.host.hasAccount(issued.address)) {
      name = input.data.name ?? this.host.inviteDisplayName(issued.address);
      // The code stays valid: the same one goes again with the name.
      if (!name) return failure(400, 'email_login_name_required', 'A name is needed for a new account');
    }
    issued.code.used = true;
    return { status: 200, body: this.host.startSession(issued.address, name) };
  }

  /** Redeems a password code: sets the password of the client account and starts the session. */
  resetPassword(body: unknown): EmailLoginResponse {
    if (!this.enabled) return failure(503, 'email_login_unavailable', 'E-mail login is not available');
    const input = PasswordResetRequest.safeParse(body);
    if (!input.success) return failure(400, 'invalid_request', 'Invalid request');
    if (this.rateLimitedFor !== null) return this.limited(this.rateLimitedFor);
    const address = input.data.email.trim().toLowerCase();
    const issued = this.liveCode(address, 'password', input.data.code);
    if ('response' in issued) return issued.response;
    issued.code.used = true;
    if (!this.host.hasClientAccount(address))
      return failure(403, 'email_login_no_access', 'This address may not set a password');
    return { status: 200, body: this.host.setPassword(address, input.data.password) };
  }

  /** The live code of the address for the purpose when the given one is right; else the answer to send. */
  private liveCode(
    address: string | null,
    purpose: CodePurpose,
    given: string,
  ): { address: string; code: IssuedCode } | { response: EmailLoginResponse } {
    const issued = address ? this.codes.get(address) : undefined;
    const invalid = { response: failure(400, 'email_code_invalid', 'The code is not valid') };
    if (
      !address ||
      !issued ||
      issued.used ||
      issued.expiresAt <= Date.now() ||
      issued.failed >= MAX_FAILED_ATTEMPTS
    )
      return invalid;
    // A code of the other purpose never matches, and the try counts.
    if (issued.purpose !== purpose || issued.code !== given) {
      issued.failed += 1;
      return invalid;
    }
    return { address, code: issued };
  }

  private limited(seconds: number): EmailLoginResponse {
    return failure(429, 'email_login_rate_limited', 'Too many attempts', { retryAfterSeconds: seconds });
  }
}
