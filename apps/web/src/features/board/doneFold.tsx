import { useState } from 'react';
import { Button } from '../../components/Button';
import { t } from '../../i18n/t';
import type { BoardEntry } from './useBoardModel';

/** How many of the newest finished cards the collapsed "Kész" shows, on the phone and on the desktop alike. */
export const DONE_PREVIEW = 3;

/**
 * Finished cards, newest first, folded to the newest few. A search shows every match, and the fold
 * stays open while the page is: it is page state, so opening a card and closing it leaves it as it was.
 * `list` must already be in order.
 */
export function useDoneFold(list: readonly BoardEntry[], searching: boolean) {
  const [expanded, setExpanded] = useState(false);
  const collapsible = !searching && list.length > DONE_PREVIEW;
  const shown = collapsible && !expanded ? list.slice(0, DONE_PREVIEW) : list;
  const toggle = collapsible ? (
    <Button
      variant="muted"
      size="sm"
      fullWidth
      aria-expanded={expanded}
      onClick={() => setExpanded((open) => !open)}
    >
      {expanded ? t('board.doneFewer') : t('board.doneAll', { count: list.length })}
    </Button>
  ) : null;
  return { shown, toggle };
}
