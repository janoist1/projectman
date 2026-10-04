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
  return {
    show,
    from,
    open(next: SettingsShow) {
      navigate(
        { pathname: location.pathname, search: `?${showParams(next, from ?? undefined)}` },
        {
          state: { settingsSelection: true },
        },
      );
    },
    close() {
      if (location.state?.settingsSelection) navigate(-1);
      else {
        const next = new URLSearchParams(location.search);
        for (const key of ['show', 'after', 'from']) next.delete(key);
        navigate({ pathname: location.pathname, search: next.toString() }, { replace: true });
      }
    },
  };
}
