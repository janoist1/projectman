import { isAllowedPushEndpoint } from '@projectman/shared';
import type { PushSendOutcome, PushTransport } from '../../contracts';

/** Converts provider errors without retaining their endpoint, request headers or payload. */
export function pushOutcomeOf(error: unknown): PushSendOutcome {
  const value = error as { statusCode?: number; code?: string; message?: string } | null;
  const status = value?.statusCode;
  if (status && status >= 200 && status < 300) return { result: 'ok' };
  if (status === 404 || status === 410) return { result: 'expired' };
  const failure =
    status === 429
      ? 'rate_limited'
      : status === 413
        ? 'payload_too_large'
        : status === 400 || status === 401 || status === 403
          ? 'rejected'
          : status && status >= 500 && status < 600
            ? 'service_error'
            : value?.code === 'ETIMEDOUT' ||
                value?.code === 'ESOCKETTIMEDOUT' ||
                value?.message === 'Socket timeout'
              ? 'timeout'
              : 'network';
  return { result: 'failed', failure };
}
export function createPushTransport(): PushTransport {
  return {
    async send(input) {
      if (!isAllowedPushEndpoint(input.endpoint)) return { result: 'failed', failure: 'rejected' };
      try {
        const { default: webPush } = await import('web-push');
        // web-push uses https.request directly and does not follow redirects.
        const result = await webPush.sendNotification(
          { endpoint: input.endpoint, keys: input.keys },
          input.payload,
          {
            TTL: input.ttlSeconds,
            urgency: input.urgency,
            timeout: input.timeoutMs,
            vapidDetails: input.vapid,
          },
        );
        return pushOutcomeOf(result);
      } catch (error) {
        return pushOutcomeOf(error);
      }
    },
  };
}
