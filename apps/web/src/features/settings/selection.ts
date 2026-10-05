import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router';

export type SettingsShow =
  | { type: 'stage' | 'column' | 'label'; id: string }
  | { type: 'new-stage'; after?: string }
  | { type: 'new-column' }
  | { type: 'new-label' };

export function parseShow(params: URLSearchParams): SettingsShow | null {
  const value = params.get('show');
  if (!value) return null;
  const match = /^(stage|column|label):([^:]+)$/.exec(value);
  if (match) return { type: match[1] as 'stage' | 'column' | 'label', id: match[2]! };
  if (value === 'new-stage') {
    const after = params.get('after');
    return after ? { type: value, after } : { type: value };
  }
  if (value === 'new-column' || value === 'new-label') return { type: value };
  return null;
}

export function showParams(show: SettingsShow | null, from?: 'how-we-work'): URLSearchParams {
  const params = new URLSearchParams();
  if (show) {
    params.set('show', 'id' in show ? `${show.type}:${show.id}` : show.type);
    if (show.type === 'new-stage' && show.after) params.set('after', show.after);
    if (from) params.set('from', from);
  }
  return params;
}

/** Opening pushes a history entry; closing consumes it, or replaces a direct link. */
export function useSettingsSelection() {
  const location = useLocation();
  const navigate = useNavigate();
  const params = new URLSearchParams(location.search);
  const show = parseShow(params);
  const from = params.get('from') === 'how-we-work' ? ('how-we-work' as const) : null;
  const closing = useRef<{ key: string; search: string } | null>(null);
  useEffect(() => {
    const target = closing.current;
    if (!target || target.key !== location.key) return;
    closing.current = null;
    if (location.search !== target.search)
      navigate(
        { pathname: location.pathname, search: target.search },
        { replace: true, state: location.state },
      );
  }, [location, navigate]);
  const history = location.state?.settingsSelection as
    { depth: number; key: string; search: string } | undefined;
  return {
    show,
    from,
    open(next: SettingsShow) {
      navigate(
        { pathname: location.pathname, search: `?${showParams(next, from ?? undefined)}` },
        {
          state: {
            ...location.state,
            settingsSelection: history
              ? { ...history, depth: history.depth + 1 }
              : { depth: 1, key: location.key, search: clearedSearch(location.search) },
          },
        },
      );
    },
    close() {
      if (history) {
        closing.current = { key: history.key, search: history.search };
        navigate(-history.depth);
      } else {
        const next = new URLSearchParams(location.search);
        for (const key of ['show', 'after', 'from']) next.delete(key);
        navigate({ pathname: location.pathname, search: next.toString() }, { replace: true });
      }
    },
  };
}

function clearedSearch(search: string): string {
  const params = new URLSearchParams(search);
  for (const key of ['show', 'after', 'from']) params.delete(key);
  return params.size ? `?${params}` : '';
}
