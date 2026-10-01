import { isApiError } from '../api/client';
import { t, tDynamic } from '../i18n/t';

/**
 * Message for a server error code (ApiError.code or a websocket error event), if known. Every
 * code of the shared ERROR_CODES has one: the locale's `errors.codes` is typed against it.
 */
export function codeMessage(code: string): string | null {
  const message = tDynamic(`errors.codes.${code}`, '');
  return message || null;
}

/** User-facing message for any error thrown by the data layer. */
export function errorMessage(error: unknown): string {
  if (isApiError(error)) {
    const known = codeMessage(error.code);
    if (known) {
      if (error.code === 'role_in_use' && error.details && typeof error.details === 'object') {
        const details = error.details as { members?: unknown; tempWorkers?: unknown };
        const handles = Array.isArray(details.members)
          ? details.members.filter((value): value is string => typeof value === 'string')
          : [];
        return [
          known,
          handles.length
            ? t('roleCatalogue.members', { handles: handles.join(t('common.listSeparator')) })
            : '',
          details.tempWorkers === true ? t('roleCatalogue.tempWorkers') : '',
        ]
          .filter(Boolean)
          .join(' ');
      }
      if (error.code === 'stage_in_use' && error.details && typeof error.details === 'object') {
        const details = error.details as { stageId?: unknown; tasks?: unknown };
        if (typeof details.stageId === 'string' && typeof details.tasks === 'number')
          return t('settings.pipeline.stageInUse', { stage: details.stageId, count: details.tasks });
      }
      if (error.code === 'handover_uncommitted' && error.details && typeof error.details === 'object') {
        const details = error.details as { path?: unknown; changes?: unknown };
        if (typeof details.path === 'string' && typeof details.changes === 'number')
          return `${known} ${t('errors.handoverUncommitted', { path: details.path, count: details.changes })}`;
      }
      return known;
    }
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
