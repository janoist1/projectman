import { isApiError } from '../api/client';
import { t, tDynamic } from '../i18n/t';

/** Message for a server error code (ApiError.code or a websocket error event), if known. */
export function codeMessage(code: string): string | null {
  const message = tDynamic(`errors.codes.${code}`, '');
  return message || null;
}

/** User-facing message for any error thrown by the data layer. */
export function errorMessage(error: unknown): string {
  if (isApiError(error)) {
    const known = codeMessage(error.code);
    if (known) return known;
    if (error.code === 'invalid_response') return t('errors.invalidResponse');
    if (error.isNetworkError) return t('errors.network');
    if (error.status === 401) return t('errors.unauthorized');
    if (error.status === 403) return t('errors.forbidden');
    if (error.status === 404) return t('errors.notFound');
    if (error.status === 409) return t('errors.conflict');
  }
  return t('errors.generic');
}

/** Machine code shown under error messages, to help when reporting a problem. */
export function errorCode(error: unknown): string | null {
  if (isApiError(error)) return error.code;
  return null;
}

/** 409 approval_requested is not a failure: the approvers were asked and the task waits. */
export function isApprovalRequested(error: unknown): boolean {
  return isApiError(error) && error.code === 'approval_requested';
}

export function isGateBlocked(error: unknown): boolean {
  return isApiError(error) && error.code === 'gate_blocked';
}
