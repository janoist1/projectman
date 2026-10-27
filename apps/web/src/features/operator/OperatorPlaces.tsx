import { useMemo } from 'react';
import { uiPlaceKey } from '@projectman/shared';
import type { UiPlace } from '@projectman/shared';
import { useBoard } from '../../api/queries';
import { useProject, useProjectIndexes } from '../../app/contexts';
import { ButtonLink } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { t } from '../../i18n/t';
import { placeLabel, placePath, placeState, useUiLocation } from './places';
import styles from './OperatorPlaces.module.css';

/**
 * The places the project manager offers in a message (PM-1071), one button each. A click only follows the
 * link: the page where the reader is stays as it is until then. The state is the reader's own: a part they
 * do not see is not a button, and the place they are at is marked as such.
 */
export function OperatorPlaces({ places }: { places: readonly UiPlace[] }) {
  const { key, me } = useProject();
  const board = useBoard(key);
  const { members } = useProjectIndexes(key);
  const from = useUiLocation(null);
  const access = me.projects.find((project) => project.key === key)?.access;
  const known = useMemo(
    () => ({
      titles: new Map((board.data?.tasks ?? []).map((task) => [task.key, task.title])),
      names: new Map([...members.values()].map((member) => [member.handle, member.displayName])),
    }),
    [board.data, members],
  );
  if (!board.data) return null;

  return (
    <div className={styles.places} data-places>
      {places.map((place) => {
        const state = placeState(place, from, access, known);
        const label = placeLabel(place, known);
        const id = uiPlaceKey(place);
        if (state === 'unavailable')
          return (
            <p key={id} className={styles.unavailable}>
              {t('operator.place.unavailable')}
            </p>
          );
        if (state === 'here')
          return (
            <span key={id} className={styles.here} aria-current="page">
              <Icon name="check" size={14} strokeWidth={2.4} />
              <span className={styles.name}>{t('operator.place.here', { place: label })}</span>
            </span>
          );
        return (
          <ButtonLink
            key={id}
            className={styles.place}
            to={placePath(key, place, from)}
            variant="secondary"
            size="sm"
            iconRight="arrowRight"
            aria-label={t('operator.place.go', { place: label })}
          >
            <span className={styles.name}>{t('operator.place.go', { place: label })}</span>
          </ButtonLink>
        );
      })}
    </div>
  );
}
