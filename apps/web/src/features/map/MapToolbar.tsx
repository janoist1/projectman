import { MAP_STATE_ORDER } from '@projectman/shared';
import { Button } from '../../components/Button';
import { SegmentedControl } from '../../components/SegmentedControl';
import { StateMark } from '../../components/StateMark';
import { t } from '../../i18n/t';
import type { FilterOption } from '../board/boardFilters';
import { FilterSelect } from '../board/FilterSelect';
import type { MapShow } from './mapFilters';
import styles from './MapToolbar.module.css';

/**
 * The map's tool row (PM-406): the state filter with its counts, the member filter and "Szűrők törlése".
 * The overview and the zoomed view share it; only the overview has the legend.
 */
export function MapToolbar({
  show,
  member,
  counts,
  assignees,
  onShow,
  onMember,
  onClear,
  clearable,
  legend = false,
}: {
  show: MapShow;
  member: string;
  counts: { all: number; needsYou: number; blocked: number };
  assignees: readonly FilterOption[];
  onShow: (value: MapShow) => void;
  onMember: (value: string) => void;
  onClear: () => void;
  /** Whether "Szűrők törlése" is offered (some filter is set and there is something to show). */
  clearable: boolean;
  legend?: boolean;
}) {
  const options: { value: MapShow; label: string; count: number }[] = [
    { value: 'all', label: t('map.filters.all'), count: counts.all },
    { value: 'needsYou', label: t('map.filters.needsYou'), count: counts.needsYou },
    { value: 'blocked', label: t('map.filters.blocked'), count: counts.blocked },
  ];
  return (
    <div className={styles.toolbar}>
      <SegmentedControl label={t('map.filtersLabel')} options={options} value={show} onChange={onShow} />
      <FilterSelect
        className={styles.member}
        label={t('map.member')}
        anyLabel={t('map.memberAny')}
        value={member}
        options={assignees}
        onChange={onMember}
      />
      {clearable ? (
        <Button variant="ghost" size="md" onClick={onClear}>
          {t('map.clearFilters')}
        </Button>
      ) : null}
      {legend ? (
        <ul className={styles.legend} aria-label={t('map.legend.label')}>
          {MAP_STATE_ORDER.map((state) => (
            <li key={state} className={styles.legendItem}>
              <StateMark state={state} />
              {t(`map.legend.${state}`)}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
