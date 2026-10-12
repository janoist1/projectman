/**
 * The one-time launch code the projectman Feedback page puts into the address it opens (PM-506,
 * `feedbackLaunchUrl`): `#pm-feedback=<code>[&pm-feedback-mark=<id>]`, or the same as a query
 * (`?pm-feedback=…`) when the page is a hash-routed app. The widget reads it from either place and
 * removes it from the address at once, so it never stays in the history or in a copied link.
 */
export interface LaunchParams {
  code: string;
  markId: string | null;
}

const CODE_KEY = 'pm-feedback';
const MARK_KEY = 'pm-feedback-mark';

const CODE_FORMAT = /^[A-Za-z0-9_-]{43}$/;
const MARK_FORMAT = /^fbm_[a-z0-9]{10,32}$/;

export const isWellFormedCode = (code: string): boolean => CODE_FORMAT.test(code);

interface Taken {
  code: string | null;
  mark: string | null;
  rest: string;
}

/** Takes the two parameters out of a `a=b&c=d` string; `rest` is what remains. */
function takeFrom(source: string): Taken {
  const params = new URLSearchParams(source);
  const code = params.get(CODE_KEY);
  const mark = params.get(MARK_KEY);
  params.delete(CODE_KEY);
  params.delete(MARK_KEY);
  return { code, mark, rest: params.toString() };
}

type Place = Pick<Window, 'location' | 'history'>;

/**
 * Reads and removes the launch parameters of the current address (`history.replaceState`).
 * Returns null, and leaves the address alone, when there are none.
 */
export function takeLaunchParams(win: Place): LaunchParams | null {
  const url = new URL(win.location.href);

  const fromSearch = takeFrom(url.search.slice(1));

  // `#pm-feedback=…` (the whole fragment is parameters) or `#/route?pm-feedback=…` (a hash router).
  const hash = url.hash.slice(1);
  const queryAt = hash.indexOf('?');
  const wholeFragment = queryAt < 0 && hash.includes(CODE_KEY);
  const routePart = wholeFragment ? '' : queryAt < 0 ? hash : hash.slice(0, queryAt);
  const fromHash = takeFrom(wholeFragment ? hash : queryAt < 0 ? '' : hash.slice(queryAt + 1));

  const code = fromHash.code ?? fromSearch.code;
  const mark = fromHash.mark ?? fromSearch.mark;
  if (code === null && mark === null) return null;

  const search = fromSearch.rest ? `?${fromSearch.rest}` : '';
  const fragment = `${routePart}${fromHash.rest ? `?${fromHash.rest}` : ''}`;
  win.history.replaceState(win.history.state, '', `${url.pathname}${search}${fragment ? `#${fragment}` : ''}`);

  if (code === null) return null;
  return { code, markId: mark !== null && MARK_FORMAT.test(mark) ? mark : null };
}
