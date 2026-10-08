import { useRef } from 'react';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { PageHeader } from '../../components/PageHeader';
import { EmptyState, ErrorState } from '../../components/States';
import { t } from '../../i18n/t';
import { GroupTile } from './GroupTile';
import { MapToolbar } from './MapToolbar';
import { useGroupMotion } from './useGroupMotion';
import { mapQuery, useMapFilters } from './mapFilters';
import { useReturnFocus } from './returnFocus';
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

  // Coming back from a zoomed group, the focus goes to the group's tile (PM-407).
  useReturnFocus(listRef, Boolean(data && pipeline));

  const header = (summary: string | null, loading = true) => (
    <PageHeader
      title={t('map.title')}
      subtitle={
        summary ?? (loading ? <span className={styles.summarySkeleton} aria-hidden="true" /> : undefined)
      }
      className={styles.header}
    />
  );

  if (board.isError && !board.data) {
    return (
      <div className={styles.page}>
        {header(null, false)}
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

  return (
    <div className={styles.page}>
      {header(summary)}
      <MapToolbar
        show={filters.show}
        member={member}
        counts={{ all: totals.open, needsYou: totals.needsYou, blocked: totals.blocked }}
        assignees={assignees}
        onShow={filters.setShow}
        onMember={filters.setMember}
        onClear={filters.clear}
        clearable={filtered && groups.length > 0}
        legend
      />
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
              query={mapQuery(filters.show, filters.member)}
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
