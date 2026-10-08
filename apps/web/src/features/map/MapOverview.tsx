import { useRef } from 'react';
import { MAP_STATE_ORDER } from '@projectman/shared';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { PageHeader } from '../../components/PageHeader';
import { SegmentedControl } from '../../components/SegmentedControl';
import { EmptyState, ErrorState } from '../../components/States';
import { StateMark } from '../../components/StateMark';
import { t } from '../../i18n/t';
import { FilterSelect } from '../board/FilterSelect';
import { GroupTile } from './GroupTile';
import { useGroupMotion } from './useGroupMotion';
import { useMapFilters } from './mapFilters';
import type { MapShow } from './mapFilters';
import { groupTitle, useWorkMap } from './useWorkMap';
import styles from './MapOverview.module.css';

const SKELETON_TILES = 8;

/**
 * The map's overview (PM-379): one tile per open theme or collecting card, plus "Egyéb" for the rest,
 * the urgent groups first. The filters live in the query.
 */
export function MapOverview() {
  const { key, can, openNewTask } = useProject();
  const filters = useMapFilters();
  const { board, pipeline, data, assignees, member } = useWorkMap(filters.show, filters.member);
  const listRef = useRef<HTMLUListElement>(null);
  const items = useRef(new Map<string, HTMLElement>());
  const flashing = useGroupMotion(listRef, items, data?.groups ?? [], `${filters.show}|${member}`);

  const header = (summary: string | null) => (
    <PageHeader
      title={t('map.title')}
      subtitle={summary ?? <span className={styles.summarySkeleton} aria-hidden="true" />}
      className={styles.header}
    />
  );

  if (board.isError && !board.data) {
    return (
      <div className={styles.page}>
        {header(null)}
        <ErrorState error={board.error} onRetry={() => void board.refetch()} />
      </div>
    );
  }

  if (!data || !pipeline) {
    return (
      <div className={styles.page}>
        {header(null)}
        <ul className={styles.tiles} aria-busy="true" aria-label={t('map.groups')}>
          {Array.from({ length: SKELETON_TILES }, (_, index) => (
            <li key={index} className={styles.skeleton} aria-hidden="true" />
          ))}
        </ul>
      </div>
    );
  }

  const { groups, totals } = data;
  const summary = t('map.summary', {
    needs: totals.needsYou,
    blocked: totals.blocked,
    working: totals.working,
    open: totals.open,
  });

  if (data.empty) {
    return (
      <div className={styles.page}>
        {header(summary)}
        <EmptyState
          icon="nodes"
          titleAs="h2"
          title={t('map.empty.title')}
          body={t('map.empty.body')}
          action={
            can.createTasks ? (
              <Button variant="primary" icon="plus" onClick={() => openNewTask()}>
                {t('map.empty.newTask')}
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  }

  const filtered = filters.show !== 'all' || member !== '';
  const good = filters.show !== 'all' && member === '';
  const base = `/p/${key}/map`;
  const options: { value: MapShow; label: string; count: number }[] = [
    { value: 'all', label: t('map.filters.all'), count: totals.open },
    { value: 'needsYou', label: t('map.filters.needsYou'), count: totals.needsYou },
    { value: 'blocked', label: t('map.filters.blocked'), count: totals.blocked },
  ];

  return (
    <div className={styles.page}>
      {header(summary)}
      <div className={styles.toolbar}>
        <SegmentedControl
          label={t('map.filtersLabel')}
          options={options.map(({ value, label, count }) => ({ value, label, count }))}
          value={filters.show}
          onChange={filters.setShow}
        />
        <FilterSelect
          className={styles.member}
          label={t('map.member')}
          anyLabel={t('map.memberAny')}
          value={member}
          options={assignees}
          onChange={filters.setMember}
        />
        {filtered && groups.length > 0 ? (
          <Button variant="ghost" size="md" onClick={filters.clear}>
            {t('map.clearFilters')}
          </Button>
        ) : null}
        <ul className={styles.legend} aria-label={t('map.legend.label')}>
          {MAP_STATE_ORDER.map((state) => (
            <li key={state} className={styles.legendItem}>
              <StateMark state={state} />
              {t(`map.legend.${state}`)}
            </li>
          ))}
        </ul>
      </div>
      {data.firstUse ? (
        <div className={styles.firstUse} role="note">
          <span>{t('map.firstUse.body')}</span>
          {can.createTasks ? (
            <Button variant="secondary" size="sm" icon="plus" onClick={() => openNewTask({ kind: 'theme' })}>
              {t('map.firstUse.newTheme')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {groups.length === 0 ? (
        <EmptyState
          // Good news only when nothing waits or is stuck; a filter that merely hides the cards is neutral.
          icon={good ? 'check' : 'filter'}
          tone={good ? 'ok' : 'neutral'}
          title={t(
            filters.show === 'needsYou'
              ? 'map.emptyFilter.needsYou'
              : filters.show === 'blocked'
                ? 'map.emptyFilter.blocked'
                : 'map.emptyFilter.all',
          )}
          body={t('map.emptyFilter.body')}
          action={
            <Button variant="secondary" onClick={filters.clear}>
              {t('map.clearFilters')}
            </Button>
          }
        />
      ) : (
        <ul ref={listRef} className={styles.tiles} aria-label={t('map.groups')}>
          {groups.map((group) => (
            <GroupTile
              key={group.key}
              group={group}
              title={groupTitle(group, data.titles)}
              base={base}
              pipeline={pipeline}
              flash={flashing.has(group.key)}
              itemRef={(element) => {
                if (element) items.current.set(group.key, element);
                else items.current.delete(group.key);
              }}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
