import type { UiLanguage } from '@projectman/shared';

/**
 * The mailer of the one-time e-mail login code (PM-664, PM-669). The adapter only delivers a code the
 * caller made; it keeps no state and decides nothing about accounts, limits or the HTTP answer.
 */
export interface EmailCodeMailInput {
  to: string;
  code: string;
  /** The language the mail is written in: the account's, else the request's, else the default (PM-1177). */
  language: UiLanguage;
  /** UTC ISO date-time (`2026-10-14T17:42:00.000Z`) after which the code no longer works. */
  expiresAt: string;
  /** What the code is for (PM-946); the letter says so. Absent: a login code. */
  purpose?: EmailCodePurpose;
}

/** A login code logs in; a password code sets a new password. The two are never interchangeable. */
export type EmailCodePurpose = 'login' | 'password';

export interface EmailCodeMailer {
  send(input: EmailCodeMailInput): Promise<void>;
}

/**
 * What the e-mail login may ask of the members' side (PM-670). Eligible means the address has a client
 * account or at least one open client invitation, and holds no other access anywhere.
 */
export type EmailLoginStanding =
  | { eligible: false }
  | {
      eligible: true;
      /** The existing account, or null when the first login creates it. */
      userId: string | null;
      clientProjects: number;
      openClientInvites: number;
      /** The first non-empty display name of the open client invitations, oldest first. */
      inviteDisplayName: string | null;
      /** The existing account's system language; null when the first login creates the account. */
      language: UiLanguage | null;
    };

export interface EmailLoginDirectory {
  standing(email: string): Promise<EmailLoginStanding>;
  /** The address of an open client invitation by its token, else null. */
  inviteEmail(token: string): string | null;
  /** Accepts all open client invitations of the address; a new account is passwordless and named `newAccountName`. */
  acceptOpenClientInvites(
    email: string,
    newAccountName: string | null,
    language?: UiLanguage,
  ): Promise<{ userId: string | null; accepted: number }>;
}

export const EMAIL_CODE_DELIVERY_FAILED = 'email_code_delivery_failed';

/** A coarse, fixed vocabulary for the operator's logs; nothing of the provider's text. */
export type EmailCodeDeliveryReason = 'rejected' | 'throttled' | 'credentials' | 'unavailable';

/**
 * The provider did not take the message. The message is fixed text and there is no `cause`: the raw
 * provider error carries the address and may carry more, so it is never attached or logged (the caller
 * decides the HTTP answer and logs only the code and the reason).
 */
export class EmailCodeDeliveryError extends Error {
  readonly code = EMAIL_CODE_DELIVERY_FAILED;
  readonly reason: EmailCodeDeliveryReason;

  constructor(reason: EmailCodeDeliveryReason = 'unavailable') {
    super('the login code could not be delivered');
    this.name = 'EmailCodeDeliveryError';
    this.reason = reason;
  }
}
