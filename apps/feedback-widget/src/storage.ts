import type { FeedbackSessionResponse } from '@projectman/shared';

/**
 * What the widget keeps in the browser's `localStorage` (PM-506): the tool session of this browser
 * for one project of one projectman instance, the hidden-marks choice and the "welcome shown" flag.
 * Every access is guarded: a browser may refuse storage, and then the widget works for the page's
 * life only.
 */
export type StoredSession = FeedbackSessionResponse;

const PREFIX = 'projectman-feedback';

export interface Scope {
  apiOrigin: string;
  projectKey: string;
}

export const sessionKey = (scope: Scope): string => `${PREFIX}:${scope.apiOrigin}:${scope.projectKey}`;
const hiddenKey = (scope: Scope): string => `${sessionKey(scope)}:hidden`;
const welcomeKey = (scope: Scope): string => `${PREFIX}:${scope.apiOrigin}:welcome`;
const openKey = (scope: Scope): string => `${sessionKey(scope)}:open`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

function read(key: string, store: Storage | undefined): string | null {
  try {
    return store?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
function write(key: string, value: string, store: Storage | undefined): void {
  try {
    store?.setItem(key, value);
  } catch {
    /* storage refused: the page's life only */
  }
}
function remove(key: string, store: Storage | undefined): void {
  try {
    store?.removeItem(key);
  } catch {
    /* nothing to do */
  }
}

const local = (): Storage | undefined => {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};
const tab = (): Storage | undefined => {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
};

/** The stored session, or null when there is none or what is stored is not a session. */
export function loadSession(scope: Scope): StoredSession | null {
  const raw = read(sessionKey(scope), local());
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || typeof value.token !== 'string' || value.token === '') return null;
    if (!isRecord(value.me) || !isRecord(value.project) || !isRecord(value.surface)) return null;
    return value as unknown as StoredSession;
  } catch {
    return null;
  }
}

export const saveSession = (scope: Scope, session: StoredSession): void =>
  write(sessionKey(scope), JSON.stringify(session), local());

export const clearSession = (scope: Scope): void => remove(sessionKey(scope), local());

export const isHidden = (scope: Scope): boolean => read(hiddenKey(scope), local()) === '1';
export const setHidden = (scope: Scope, hidden: boolean): void =>
  hidden ? write(hiddenKey(scope), '1', local()) : remove(hiddenKey(scope), local());

export const welcomeShown = (scope: Scope): boolean => read(welcomeKey(scope), local()) === '1';
export const markWelcomeShown = (scope: Scope): void => write(welcomeKey(scope), '1', local());

/** A mark to open after a navigation to another page of the surface (kept for this tab only). */
export const takePendingMark = (scope: Scope): string | null => {
  const value = read(openKey(scope), tab());
  if (value !== null) remove(openKey(scope), tab());
  return value;
};
export const setPendingMark = (scope: Scope, markId: string): void => write(openKey(scope), markId, tab());
