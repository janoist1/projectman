import { useEffect, useRef, useState } from 'react';
import type { Me } from '@projectman/shared';
import { isApiError } from '../../api/client';
import {
  useRequestEmailLoginCode,
  useRequestPasswordCode,
  useResetPassword,
  useVerifyEmailLogin,
} from '../../api/queries';
import { currentLanguage } from '../../i18n/language';
import { t } from '../../i18n/t';
import { retryAfterOf, useCountdown, useSingleFlight } from './emailLogin';

/** Whose code it is: an address typed on the login page, or the address an invitation was made for. */
export type CodeIdentity = { email: string } | { inviteToken: string };

export type RequestOutcome = 'sent' | 'invalid_address' | 'blocked';

export type VerifyOutcome =
  | { kind: 'ok'; me: Me }
  | { kind: 'name_required' }
  | { kind: 'invalid' }
  | { kind: 'no_access' }
  | { kind: 'failed' };

const DEFAULT_LIFETIME_SECONDS = 600;

/**
 * The state of one code login, in memory only: the waits, the problems and the announcement. The pages
 * keep the address, the code and the name. A request or a check runs once at a time: a second call while
 * one runs is dropped.
 */
export function useEmailCodeFlow(identity: CodeIdentity, purpose: 'login' | 'password' = 'login') {
  const requestLoginCode = useRequestEmailLoginCode();
  const requestPasswordCode = useRequestPasswordCode();
  const verifyCode = useVerifyEmailLogin();
  const resetPassword = useResetPassword();
  const run = useSingleFlight();
  const [busy, setBusy] = useState<'request' | 'verify' | null>(null);
  const [resendUntil, setResendUntil] = useState<number | null>(null);
  const [limit, setLimit] = useState<{ kind: 'request' | 'verify'; until: number } | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [codeInvalid, setCodeInvalid] = useState(false);
  const [resent, setResent] = useState(false);
  const [lifetimeSeconds, setLifetimeSeconds] = useState(DEFAULT_LIFETIME_SECONDS);
  const [announcement, setAnnouncement] = useState('');

  const resendLeft = useCountdown(resendUntil);
  const limitLeft = useCountdown(limit?.until ?? null);

  // The end of a wait is announced once, not every second.
  const waited = useRef(false);
  const waiting = resendLeft > 0 || limitLeft > 0;
  useEffect(() => {
    if (waiting) waited.current = true;
    else if (waited.current) {
      waited.current = false;
      setAnnouncement(t('auth.emailLogin.announceResendReady'));
    }
  }, [waiting]);

  /** Files a failure under the banner it belongs to. */
  function record(error: unknown, kind: 'request' | 'verify'): void {
    const wait = retryAfterOf(error);
    if (wait !== null) setLimit({ kind, until: Date.now() + wait * 1000 });
    else if (isApiError(error) && error.code === 'email_login_unavailable') setUnavailable(true);
    else setFailure(error);
  }

  function clearProblems(): void {
    setLimit(null);
    setUnavailable(false);
    setFailure(null);
  }

  /** Asks for a code; `resend` is a new code for the same step. */
  function request(resend = false): Promise<RequestOutcome | undefined> {
    return run(async () => {
      clearProblems();
      setBusy('request');
      try {
        const answer =
          purpose === 'password' && 'email' in identity
            ? await requestPasswordCode.mutateAsync(identity)
            : await requestLoginCode.mutateAsync({ ...identity, language: currentLanguage() });
        setResendUntil(Date.now() + answer.resendAfterSeconds * 1000);
        setLifetimeSeconds(answer.expiresInSeconds);
        setCodeInvalid(false);
        setResent(resend);
        setAnnouncement(
          resend
            ? t('auth.emailLogin.resent')
            : 'email' in identity
              ? t('auth.emailLogin.announceSent')
              : t('auth.emailLogin.announceSentInvite'),
        );
        return 'sent' as const;
      } catch (error) {
        if (isApiError(error) && error.code === 'invalid_request' && 'email' in identity)
          return 'invalid_address' as const;
        record(error, 'request');
        return 'blocked' as const;
      } finally {
        setBusy(null);
      }
    });
  }

  /** Redeems the code (already normalized); the name goes along when the account is new. */
  function verify(code: string, name?: string): Promise<VerifyOutcome | undefined> {
    return redeem(() =>
      verifyCode.mutateAsync({ ...identity, code, language: currentLanguage(), ...(name ? { name } : {}) }),
    );
  }

  /** Redeems a password code (already normalized) and sets the new password (PM-946). */
  function setPassword(code: string, password: string): Promise<VerifyOutcome | undefined> {
    if (!('email' in identity)) throw new TypeError('a password code needs an address');
    return redeem(() => resetPassword.mutateAsync({ email: identity.email, code, password }));
  }

  /** The check both redemptions share: one at a time, and every refusal filed under its banner. */
  function redeem(call: () => Promise<Me>): Promise<VerifyOutcome | undefined> {
    return run(async (): Promise<VerifyOutcome> => {
      clearProblems();
      setCodeInvalid(false);
      setResent(false);
      setBusy('verify');
      try {
        return { kind: 'ok', me: await call() };
      } catch (error) {
        if (isApiError(error)) {
          if (error.code === 'email_code_invalid') {
            setCodeInvalid(true);
            return { kind: 'invalid' };
          }
          if (error.code === 'email_login_name_required') return { kind: 'name_required' };
          if (error.code === 'email_login_no_access') {
            setFailure(error);
            return { kind: 'no_access' };
          }
        }
        record(error, 'verify');
        return { kind: 'failed' };
      } finally {
        setBusy(null);
      }
    });
  }

  /** Forgets the problems and the sent state, for a step back to the address. */
  function reset(): void {
    clearProblems();
    setCodeInvalid(false);
    setResent(false);
    setResendUntil(null);
  }

  return {
    busy,
    resendLeft,
    requestLimitLeft: limit?.kind === 'request' ? limitLeft : 0,
    verifyLimitLeft: limit?.kind === 'verify' ? limitLeft : 0,
    unavailable,
    failure,
    codeInvalid,
    resent,
    lifetimeMinutes: Math.round(lifetimeSeconds / 60),
    announcement,
    request,
    verify,
    setPassword,
    reset,
  };
}

export type EmailCodeFlow = ReturnType<typeof useEmailCodeFlow>;
