/** Why an address cannot be a feedback surface (the origin of a customer page). */
export type FeedbackOriginRefusal = 'not_url' | 'has_path' | 'bad_scheme';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function parseOrigin(input: string): { url: URL } | { refusal: FeedbackOriginRefusal } {
  const text = input.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { refusal: 'not_url' };
  }
  if (url.hostname === '' || url.username !== '' || url.password !== '') return { refusal: 'not_url' };
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { refusal: 'bad_scheme' };
  if (url.protocol === 'http:' && !LOCAL_HOSTS.has(url.hostname)) return { refusal: 'bad_scheme' };
  // A path, a query or a `#` (even an empty one) is not part of an origin; the trailing `/` is.
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '' || /[?#]/.test(text))
    return { refusal: 'has_path' };
  return { url };
}

/**
 * Why `input` is not an accepted surface address (PM-506), or null. The address is `scheme://host[:port]`:
 * `https`, or `http` only for `localhost`, `127.0.0.1` and `[::1]`; no path, query or `#` (a trailing
 * `/` is accepted).
 */
export function feedbackOriginRefusal(input: string): FeedbackOriginRefusal | null {
  const parsed = parseOrigin(input);
  return 'refusal' in parsed ? parsed.refusal : null;
}

/** The normalised form of a surface address: lower-case host, no default port, no trailing `/`; null if refused. */
export function normalizeFeedbackOrigin(input: string): string | null {
  const parsed = parseOrigin(input);
  return 'refusal' in parsed ? null : parsed.url.origin;
}
