import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode, RefObject } from 'react';
import { Link, Outlet, useMatch, useParams } from 'react-router';
import type { MapGroup } from '@projectman/shared';
import type { Task } from '@projectman/shared';
import { useProject } from '../../app/contexts';
import { Button, ButtonLink } from '../../components/Button';
import { ColumnBar } from '../../components/ColumnBar';
import { Icon } from '../../components/Icon';
import { EmptyState, ErrorState } from '../../components/States';
import { StateMark } from '../../components/StateMark';
import { t } from '../../i18n/t';
import { useDocumentTitle, useIsMobile } from '../../lib/hooks';
import { columnSegments } from '../../lib/pipeline';
import type { PipelineIndex } from '../../lib/pipeline';
import type { FilterOption } from '../board/boardFilters';
import { DrawerBaseContext } from '../board/drawerBase';
import type { DrawerBase } from '../board/drawerBase';
import type { BoardEntry } from '../board/useBoardModel';
import { GroupSignals } from './GroupTile';
import { MapCard } from './MapCard';
import { MapToolbar } from './MapToolbar';
import { PrerequisiteEdges } from './PrerequisiteEdges';
import { edgesOf, openColumns, waitingOf, zoomLanes } from './groupModel';
import type { Waiting, ZoomCard, ZoomLane } from './groupModel';
import { mapQuery, useMapFilters } from './mapFilters';
import { rememberZoomed } from './returnFocus';
import type { ReturnState } from './returnFocus';
import { useLiveMotion } from './useGroupMotion';
import { groupTitle, useWorkMap } from './useWorkMap';
import styles from './MapGroupView.module.css';

const SKELETON_CARDS = 8;
const PULSE_MS = 600;
const NO_WAITING: Waiting = { keys: [], drawn: [] };
const NONE: ReadonlySet<string> = new Set();

type WorkMapData = NonNullable<ReturnType<typeof useWorkMap>['data']>;

interface BodyProps {
  group: MapGroup;
  /** The group's signals under the member filter. */
  scoped: MapGroup;
  data: WorkMapData;
  pipeline: PipelineIndex;
  byKey: ReadonlyMap<string, BoardEntry>;
  tasks: readonly Task[];
  assignees: readonly FilterOption[];
  show: ReturnType<typeof useMapFilters>['show'];
  member: string;
  onShow: ReturnType<typeof useMapFilters>['setShow'];
  onMember: ReturnType<typeof useMapFilters>['setMember'];
  onClear: () => void;
  base: DrawerBase;
  isMobile: boolean;
}

/**
 * The map's zoomed view of one group (PM-407): the board's open columns as columns, the group's lanes as
 * rows, the open cards in the cells, and the arrows between a card and the prerequisite it waits for. The
 * card drawer opens over it (the nested route), and closes back here with the filters. The filters live in
 * the query, as in the overview.
 */
export function MapGroupView() {
  const { key } = useProject();
  const { groupKey = '' } = useParams();
  const filters = useMapFilters();
  const { board, pipeline, model, data, assignees, member } = useWorkMap(filters.show, filters.member);
  const isMobile = useIsMobile();
  const pageRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLAnchorElement>(null);

  // The map's own query only: the drawer adds its own parameters (the card size, a message).
  const query = useMemo(() => mapQuery(filters.show, filters.member), [filters.show, filters.member]);

  const base = useMemo<DrawerBase>(
    () => ({
      close: `/p/${key}/map/${groupKey}${query}`,
      card: (taskKey, sub) => `/p/${key}/map/${groupKey}/tasks/${taskKey}${sub ? `/${sub}` : ''}${query}`,
    }),
    [key, groupKey, query],
  );

  const group = data?.allGroups.find((candidate) => candidate.key === groupKey) ?? null;
  const title = group && data ? groupTitle(group, data.titles) : null;
  useDocumentTitle(title, t('map.title'));

  // The browser's Back to the overview carries no state of ours: the overview reads this.
  useEffect(() => {
    rememberZoomed(groupKey);
  }, [groupKey]);

  // Entering the zoom, the focus goes to "‹ Térkép" — unless a card's drawer opened with the page: that
  // one takes the focus (its effect runs first).
  const openedKey = useMatch('/p/:projectKey/map/:groupKey/tasks/:taskKey/*')?.params.taskKey ?? null;
  const startedOpen = useRef(openedKey !== null);
  useEffect(() => {
    if (!startedOpen.current) backRef.current?.focus();
  }, []);

  // Closing the drawer, the focus goes back to the card that opened it, when it is on the map.
  const lastOpened = useRef<string | null>(null);
  useEffect(() => {
    if (openedKey) {
      lastOpened.current = openedKey;
      return;
    }
    const wanted = lastOpened.current;
    lastOpened.current = null;
    if (!wanted) return;
    const card = Array.from(pageRef.current?.querySelectorAll<HTMLElement>('[data-card-key]') ?? []).find(
      (element) => element.dataset.cardKey === wanted,
    );
    card?.querySelector<HTMLElement>('a')?.focus();
  }, [openedKey]);

  const backState: ReturnState = { focusGroup: groupKey };
  let content: ReactNode;
  if (board.isError && !board.data) {
    content = <ErrorState error={board.error} onRetry={() => void board.refetch()} />;
  } else if (!data || !pipeline || !model || !board.data) {
    content = <Loading />;
  } else if (!group) {
    content = (
      <EmptyState
        icon="nodes"
        titleAs="h1"
        title={t('map.group.notFound.title')}
        body={t('map.group.notFound.body')}
        action={
          <ButtonLink to={`/p/${key}/map${query}`} variant="secondary" state={backState}>
            {t('map.group.notFound.back')}
          </ButtonLink>
        }
      />
    );
  } else {
    const scoped = data.scopedGroups.find((candidate) => candidate.key === group.key) ?? {
      ...group,
      signals: { needsYou: 0, blocked: 0, working: 0, waiting: 0, open: 0 },
    };
    content = (
      <GroupBody
        group={group}
        scoped={scoped}
        data={data}
        pipeline={pipeline}
        byKey={model.byKey}
        tasks={board.data.tasks}
        assignees={assignees}
        show={filters.show}
        member={member}
        onShow={filters.setShow}
        onMember={filters.setMember}
        onClear={filters.clear}
        base={base}
        isMobile={isMobile}
      />
    );
  }

  return (
    <DrawerBaseContext.Provider value={base}>
      <div ref={pageRef} className={styles.page}>
        <Link ref={backRef} to={`/p/${key}/map${query}`} state={backState} className={styles.back}>
          <Icon name="chevronLeft" size={16} strokeWidth={2.4} />
          {t('map.back')}
        </Link>
        {content}
      </div>
      <Outlet />
    </DrawerBaseContext.Provider>
  );
}

/**
 * Whether the board is wider than the room it has. Only then does the board scroll sideways: a scroller
 * ends the sticky column heads, so it is switched on just when the columns cannot fit.
 */
function useSidewaysScroll(ref: RefObject<HTMLElement | null>, present: boolean): boolean {
  const [scrolls, setScrolls] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !present) return;
    const check = () => setScrolls(element.scrollWidth > element.clientWidth + 1);
    check();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(check);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, present]);
  return scrolls;
}

function Loading() {
  return (
    <div aria-busy="true">
      <div className={styles.headSkeleton} aria-hidden="true">
        <span className={styles.skeletonLine} style={{ width: 120 }} />
        <span className={styles.skeletonLine} style={{ width: 320, height: 24 }} />
        <span className={styles.skeletonLine} style={{ width: 220 }} />
      </div>
      <ul className={styles.skeletons} aria-label={t('map.cards')}>
        {Array.from({ length: SKELETON_CARDS }, (_, index) => (
          <li key={index} className={styles.skeleton} aria-hidden="true" />
        ))}
      </ul>
    </div>
  );
}

function GroupBody({
  group,
  scoped,
  data,
  pipeline,
  byKey,
  tasks,
  assignees,
  show,
  member,
  onShow,
  onMember,
  onClear,
  base,
  isMobile,
}: BodyProps) {
  const ids = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const items = useRef(new Map<string, HTMLElement>());
  const [active, setActive] = useState<string | null>(null);
  const [pulse, setPulse] = useState<string | null>(null);

  const filtered = show !== 'all' || member !== '';
  const columns = useMemo(() => openColumns(pipeline), [pipeline]);
  const lanes = useMemo(
    () =>
      zoomLanes({
        group,
        byKey,
        states: data.states,
        staleKeys: data.staleKeys,
        pipeline,
        show,
        member,
      }),
    [group, byKey, data.states, data.staleKeys, pipeline, show, member],
  );
  const cards = useMemo(() => lanes.flatMap((lane) => lane.cards), [lanes]);
  const scrolls = useSidewaysScroll(scrollerRef, cards.length > 0);
  const drawn = useMemo(() => new Set(cards.map((card) => card.task.key)), [cards]);
  const waiting = useMemo(
    () => new Map(cards.map((card) => [card.task.key, waitingOf(card, tasks, drawn, isMobile)])),
    [cards, tasks, drawn, isMobile],
  );
  const elsewhere = useMemo(() => {
    const inGroup = new Set(group.cardKeys);
    const outside = new Set<string>();
    for (const wait of waiting.values()) {
      for (const key of [...wait.keys, ...wait.drawn]) if (!inGroup.has(key)) outside.add(key);
    }
    return outside;
  }, [group, waiting]);
  // No arrows on a phone: the waits are a list there.
  const edges = useMemo(() => (isMobile ? [] : edgesOf(cards, tasks)), [isMobile, cards, tasks]);
  const linked = useMemo(() => {
    if (!active) return null;
    const keys = new Set<string>();
    for (const edge of edges) {
      if (edge.from === active || edge.to === active) {
        keys.add(edge.from);
        keys.add(edge.to);
      }
    }
    return keys.size > 0 ? keys : null;
  }, [active, edges]);
  const layout = useMemo(() => cards.map((card) => `${card.task.key}@${card.columnId}`).join('|'), [cards]);

  const entries = useMemo(
    () =>
      cards.map((card) => ({
        key: card.task.key,
        signature: JSON.stringify([card.mapState, card.stale, card.columnId, card.state.label]),
      })),
    [cards],
  );
  const flashing = useLiveMotion(bodyRef, items, entries, `${show}|${member}|${isMobile}`);

  useEffect(() => {
    if (!pulse) return;
    const timer = window.setTimeout(() => setPulse(null), PULSE_MS);
    return () => window.clearTimeout(timer);
  }, [pulse]);

  // A phone's "Vár erre" key: scroll to the card and focus it.
  const jumpTo = useCallback((taskKey: string) => {
    const element = items.current.get(taskKey);
    if (!element) return;
    const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    element.scrollIntoView?.({ block: 'center', behavior: calm ? 'auto' : 'smooth' });
    element.querySelector<HTMLElement>('a')?.focus({ preventScroll: true });
    setPulse(taskKey);
  }, []);

  const renderCard = (card: ZoomCard) => {
    const taskKey = card.task.key;
    return (
      <MapCard
        key={taskKey}
        card={card}
        to={base.card(taskKey)}
        now={data.now}
        waiting={waiting.get(taskKey) ?? NO_WAITING}
        elsewhere={elsewhere}
        hrefOf={base.card}
        jumpable={isMobile ? drawn : NONE}
        onJump={jumpTo}
        column={isMobile ? (columns.find((column) => column.id === card.columnId) ?? null) : null}
        linked={linked?.has(taskKey) ?? false}
        flash={flashing.has(taskKey) || pulse === taskKey}
        onActive={setActive}
        itemRef={(element) => {
          if (element) items.current.set(taskKey, element);
          else items.current.delete(taskKey);
        }}
      />
    );
  };

  const kind = t(`map.kind.${group.kind}`);
  const title = groupTitle(group, data.titles);
  const segments = columnSegments(group.progress.byStage, pipeline);
  const distribution = segments
    .map(({ column, count }) => t('board.themes.columnCount', { column: column.name, count }))
    .join(' · ');

  const emptyTitle =
    group.progress.total === 0
      ? t('map.group.noCards')
      : !filtered
        ? t('map.group.allDone')
        : t(
            show === 'needsYou'
              ? 'map.group.emptyFilter.needsYou'
              : show === 'blocked'
                ? 'map.group.emptyFilter.blocked'
                : 'map.group.emptyFilter.all',
          );
  const good = group.progress.total > 0 && (!filtered || (show !== 'all' && member === ''));

  const laneTitle = (zoomLane: ZoomLane) => {
    const { lane, collector } = zoomLane;
    if (lane.kind === 'collector' && lane.collectorKey) {
      const collectorTitle = collector?.task.title ?? data.titles.get(lane.collectorKey) ?? lane.collectorKey;
      const mapState = data.states.get(lane.collectorKey) ?? null;
      return (
        <Link to={base.card(lane.collectorKey)} className={styles.laneLink}>
          {mapState ? <StateMark state={mapState} /> : null}
          <span className={styles.laneKey}>{lane.collectorKey}</span>
          <span className={styles.laneName}>{collectorTitle}</span>
          {collector ? <span className={styles.laneStage}>{collector.state.label}</span> : null}
        </Link>
      );
    }
    // A collector lane always has its card's key; the rest are named by the locale.
    return t(`map.lane.${lane.kind === 'collector' ? 'parts' : lane.kind}`);
  };

  const countOf = (columnId: string) => cards.filter((card) => card.columnId === columnId).length;
  const doneTotal = lanes.reduce((sum, zoomLane) => sum + zoomLane.lane.done, 0);

  return (
    <>
      <header className={styles.head}>
        <div className={styles.kind}>
          <span className={styles.kindName}>{kind}</span>
          {group.kind !== 'other' ? <span className={styles.key}>{group.key}</span> : null}
        </div>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>{title}</h1>
          {group.kind !== 'other' ? (
            <ButtonLink to={base.card(group.key)} variant="secondary" size="md">
              {t(group.kind === 'theme' ? 'map.openTheme' : 'map.openCollector')}
            </ButtonLink>
          ) : null}
        </div>
        <div className={styles.facts}>
          <span className={styles.progress} title={distribution || undefined}>
            <ColumnBar segments={segments} total={group.progress.total} />
            <span className={styles.count}>
              {t('map.progress', { done: group.progress.done, total: group.progress.total })}
            </span>
          </span>
          <GroupSignals group={scoped} className={styles.signals} />
        </div>
      </header>
      <MapToolbar
        show={show}
        member={member}
        counts={{
          all: scoped.signals.open,
          needsYou: scoped.signals.needsYou,
          blocked: scoped.signals.blocked,
        }}
        assignees={assignees}
        onShow={onShow}
        onMember={onMember}
        onClear={onClear}
        clearable={filtered && cards.length > 0}
        legend
      />
      {cards.length === 0 ? (
        <EmptyState
          icon={good ? 'check' : group.progress.total === 0 ? 'nodes' : 'filter'}
          tone={good ? 'ok' : 'neutral'}
          titleAs="h2"
          title={emptyTitle}
          action={
            filtered && group.progress.total > 0 ? (
              <Button variant="secondary" onClick={onClear}>
                {t('map.clearFilters')}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div ref={scrollerRef} className={styles.scroller} data-scroll={scrolls ? '' : undefined}>
          <div
            ref={bodyRef}
            className={styles.body}
            data-linking={!isMobile && linked ? '' : undefined}
            style={{ '--map-columns': columns.length } as CSSProperties}
          >
            {isMobile ? null : (
              <>
                <PrerequisiteEdges containerRef={bodyRef} edges={edges} active={active} layout={layout} />
                {/* Each cell names its column for a screen reader; this row is the sighted reader's. */}
                <div className={styles.columns} aria-hidden="true">
                  {columns.map((column) => (
                    <div key={column.id} className={styles.columnHead} data-column-color={column.color}>
                      <span className={styles.columnDot} />
                      <span className={styles.columnName}>{column.name}</span>
                      <span className={styles.columnCount}>{countOf(column.id)}</span>
                    </div>
                  ))}
                  <div className={styles.doneHead}>
                    {t('map.done')}
                    <span className={styles.columnCount}>{doneTotal}</span>
                  </div>
                </div>
              </>
            )}
            {lanes.map((zoomLane, index) => {
              const headingId = `${ids}-lane-${index}`;
              return (
                <section key={zoomLane.lane.collectorKey ?? zoomLane.lane.kind} aria-labelledby={headingId}>
                  <header className={styles.laneHead}>
                    <h2 id={headingId} className={styles.laneTitle}>
                      {laneTitle(zoomLane)}
                    </h2>
                    <span className={styles.laneRule} aria-hidden="true" />
                    <span className={styles.laneCount}>
                      {t('map.laneCount', { open: zoomLane.lane.open, done: zoomLane.lane.done })}
                    </span>
                  </header>
                  {isMobile ? (
                    zoomLane.cards.length > 0 ? (
                      <ul className={styles.list} aria-label={t('map.cards')}>
                        {zoomLane.cards.map(renderCard)}
                      </ul>
                    ) : null
                  ) : (
                    <div className={styles.cells}>
                      {columns.map((column) => {
                        const cell = zoomLane.byColumn.get(column.id) ?? [];
                        return cell.length > 0 ? (
                          <ul
                            key={column.id}
                            className={styles.cell}
                            aria-label={t('map.columnCount', { column: column.name, count: cell.length })}
                          >
                            {cell.map(renderCard)}
                          </ul>
                        ) : (
                          <div key={column.id} className={styles.cell} aria-hidden="true" />
                        );
                      })}
                      <p className={styles.doneCell} data-zero={zoomLane.lane.done === 0 ? '' : undefined}>
                        {zoomLane.lane.done > 0 ? (
                          <>
                            <StateMark state="done" className={styles.doneMark} />
                            <span aria-hidden="true">{zoomLane.lane.done}</span>
                          </>
                        ) : (
                          <span aria-hidden="true">–</span>
                        )}
                        <span className="visually-hidden">
                          {t('map.columnCount', { column: t('map.done'), count: zoomLane.lane.done })}
                        </span>
                      </p>
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
