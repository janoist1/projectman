import clsx from 'clsx';
import { Icon } from '../../components/Icon';
import { t } from '../../i18n/t';
import { useFocusPlace } from './FocusContext';
import type { FocusPlaceView } from './FocusContext';
import styles from './FocusMark.module.css';

/** What the mark says: the place, and what put the card there when it is not an item itself. */
export function focusMarkLabel(place: FocusPlaceView): string {
  const { position, via } = place;
  if (!via) return t('focus.mark', { position });
  return via.kind === 'theme'
    ? t('focus.markViaTheme', { position, title: via.title })
    : t('focus.markViaCard', { position, key: via.key });
}

/** The place in words for the card's row: "2. hely, a Hibrid mód témán át". */
export function focusPlaceText(place: FocusPlaceView): string {
  const { position, via } = place;
  if (!via) return t('focus.row.place', { position });
  return via.kind === 'theme'
    ? t('focus.row.viaTheme', { position, title: via.title })
    : t('focus.row.viaCard', { position, key: via.key });
}

/**
 * "◎ 2": the card or theme is in the project's focus, at this place. Nothing is drawn for a card outside
 * the focus, and nothing at all for a viewer who may not see the focus (a client).
 */
export function FocusMark({ taskKey, className }: { taskKey: string; className?: string }) {
  const place = useFocusPlace(taskKey);
  if (!place) return null;
  const label = focusMarkLabel(place);
  return (
    <span className={clsx(styles.mark, className)} title={label} role="img" aria-label={label}>
      <Icon name="target" size={12} strokeWidth={2.4} />
      <span aria-hidden="true">{place.position}</span>
    </span>
  );
}
