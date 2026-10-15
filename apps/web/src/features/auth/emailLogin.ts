import { useCallback, useEffect, useRef, useState } from 'react';
import { EmailLoginRateLimitedDetails, LoginCode } from '@projectman/shared';
import type { Me } from '@projectman/shared';
import { isApiError } from '../../api/client';

/** Strips what a person types between the digits of a code: spaces and hyphens (`123 456`, `123-456`). */
export function normalizeLoginCode(raw: string): string {
  return raw.replace(/[\s-]/g, '');
}

/** Whether the value, as given, is a code the server accepts. */
export function isLoginCode(value: string): boolean {
  return LoginCode.safeParse(value).success;
}

/** A same-app path from the `next` parameter, else null. Only same-app paths are accepted as a return target. */
export function safeNextOrNull(value: string | null): string | null {
  return value && value.startsWith('/') && !value.startsWith('//') ? value : null;
}

/**
 * Where a client lands after a redeemed code: the safe `next` (not an invitation, which the code login
 * has just accepted), the invitation's project, the only project, else the project list.
 */
export function emailLoginTarget(me: Me, next: string | null, preferredProject?: string): string {
  if (next && !next.startsWith('/invite/')) return next;
  if (preferredProject && me.projects.some((project) => project.key === preferredProject))
    return `/p/${preferredProject}`;
  const [only] = me.projects;
  return me.projects.length === 1 && only ? `/p/${only.key}` : '/';
}

/** The wait in seconds an `email_login_rate_limited` error carries, else null. */
export function retryAfterOf(error: unknown): number | null {
  if (!isApiError(error) || error.code !== 'email_login_rate_limited') return null;
  const details = EmailLoginRateLimitedDetails.safeParse(error.details);
  return details.success ? details.data.retryAfterSeconds : null;
}

/** `m:ss`, from whole seconds. */
export function formatCountdown(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/** The whole seconds left until `deadlineMs` (a `Date.now()` value), 0 when there is no deadline or it passed. */
export function useCountdown(deadlineMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deadlineMs === null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= deadlineMs) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [deadlineMs]);
  return deadlineMs === null ? 0 : Math.max(0, Math.ceil((deadlineMs - now) / 1000));
}

/**
 * Runs one task at a time: a second call while one runs is dropped. The lock is a ref, set at once;
 * the mutation's own `isPending` shows only after a render, too late for a double click.
 */
export function useSingleFlight(): <T>(task: () => Promise<T>) => Promise<T | undefined> {
  const busy = useRef(false);
  return useCallback(async <T>(task: () => Promise<T>) => {
    if (busy.current) return undefined;
    busy.current = true;
    try {
      return await task();
    } finally {
      busy.current = false;
    }
  }, []);
}
