import type { NanogptKeyCheck } from './provider-keys';

/** Only the HTTP status is inspected; balances and error bodies never leave this checker. */
export function createNanogptKeyCheck(fetchImpl: typeof fetch = fetch): NanogptKeyCheck {
  return async (key) => {
    try {
      const response = await fetchImpl('https://api.nano-gpt.com/api/check-balance', {
        method: 'POST',
        headers: { 'x-api-key': key },
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
      });
      await response.body?.cancel();
      if (response.ok) return 'accepted';
      if (response.status === 401 || response.status === 403) return 'rejected';
      return 'unknown';
    } catch {
      return 'unknown';
    }
  };
}
