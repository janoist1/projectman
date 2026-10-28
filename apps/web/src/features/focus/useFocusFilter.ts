import { useCallback } from 'react';
import { useSearchParams } from 'react-router';
import { useFocus } from './FocusContext';

/** The query parameter of the "Csak a fókusz" filter on the board. */
export const FOCUS_FILTER_PARAM = 'focus';

/**
 * "Csak a fókusz" (PM-438): `?focus=1` narrows the board to the cards and themes the focus
 * covers. A viewer who may not see the focus (a client) has the parameter ignored: the whole board shows.
 */
export function useFocusFilter() {
  const { visible, loading, loadFailed, places } = useFocus();
  const [params, setParams] = useSearchParams();
  const requested = params.get(FOCUS_FILTER_PARAM) === '1';
  const set = useCallback(
    (on: boolean) =>
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (on) next.set(FOCUS_FILTER_PARAM, '1');
          else next.delete(FOCUS_FILTER_PARAM);
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );
  // While the list is not known (loading, or it failed) the board is not narrowed to an empty one.
  const active = visible && requested && !loading && !loadFailed;
  return {
    active,
    /** Asked for, whatever the state of the list: the toggle shows it pressed. */
    requested: visible && requested,
    set,
    /** Whether the card or theme is covered by the focus. */
    covers: (taskKey: string) => places.has(taskKey),
  };
}
