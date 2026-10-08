import { useCallback } from 'react';
import { useSearchParams } from 'react-router';

export type MapShow = 'all' | 'needsYou' | 'blocked';

/** The query values of `show`; anything else (and no value) is "Mind". */
export function parseShow(value: string | null): MapShow {
  return value === 'needsYou' || value === 'blocked' ? value : 'all';
}

/** The map's own query (`?show=…&member=…`, or nothing): what a link inside the map carries along. */
export function mapQuery(show: MapShow, member: string): string {
  const params = new URLSearchParams();
  if (show !== 'all') params.set('show', show);
  if (member !== '') params.set('member', member);
  const text = params.toString();
  return text ? `?${text}` : '';
}

/**
 * The map's filters live in the query (`?show=needsYou|blocked&member=<handle>|@none`), so a link and
 * the browser's Back keep them. A change replaces the history entry: Back does not step through the
 * filters one by one.
 */
export function useMapFilters() {
  const [params, setParams] = useSearchParams();
  const show = parseShow(params.get('show'));
  const member = params.get('member') ?? '';

  const update = useCallback(
    (changes: { show?: MapShow; member?: string }) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (changes.show !== undefined) {
            if (changes.show === 'all') next.delete('show');
            else next.set('show', changes.show);
          }
          if (changes.member !== undefined) {
            if (changes.member === '') next.delete('member');
            else next.set('member', changes.member);
          }
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  return {
    show,
    member,
    setShow: (value: MapShow) => update({ show: value }),
    setMember: (value: string) => update({ member: value }),
    clear: () => update({ show: 'all', member: '' }),
  };
}
