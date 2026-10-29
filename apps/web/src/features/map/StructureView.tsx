import { useEffect, useMemo, useRef } from 'react';
import type { CSSProperties } from 'react';
import { Outlet, useMatch, useSearchParams } from 'react-router';
import {
  isStale,
  mapStateOf,
  staleDays,
  sharedModules,
  MAP_STATE_ORDER,
  STRUCTURE_MODULE_KINDS,
} from '@projectman/shared';
import type { MapState, StructureCard, StructureRepoView } from '@projectman/shared';
import { useProject } from '../../app/contexts';
import { Dialog } from '../../components/Dialog';
import { Fold } from '../../components/Fold';
import { Icon } from '../../components/Icon';
import { Button, ButtonLink } from '../../components/Button';
import { EmptyState, ErrorState } from '../../components/States';
import { SegmentedControl } from '../../components/SegmentedControl';
import { StateMark } from '../../components/StateMark';
import { joinNames, t } from '../../i18n/t';
import { isPageEscape, useDocumentTitle, useIsMobile } from '../../lib/hooks';
import { useNow } from '../../lib/useNow';
import { DrawerBaseContext } from '../board/drawerBase';
import { useBoardModel } from '../board/useBoardModel';
import { moduleSize, sortCards } from './structureModel';
import { StructureRoads } from './StructureRoads';
import { useStructure } from './useStructure';
import styles from './StructureView.module.css';

const colors = ['blue', 'yellow', 'teal', 'green', 'orange', 'purple', 'gray'];
const sizes = [0, 118, 148, 190, 250];
const filesText = (count: number) => t('map.structure.files', { count });
type FocusOrigin = { kind: 'card' | 'module' | 'outside'; id: string };

function RepoState({
  repo,
  retry,
  projectKey,
}: {
  repo: StructureRepoView | undefined;
  retry: () => void;
  projectKey: string;
}) {
  const status = repo?.status ?? 'missing';
  const reason = repo?.reason ?? 'failed';
  const title =
    status === 'unavailable'
      ? t(`map.structure.${reason}`)
      : status === 'invalid'
        ? t('map.structure.invalid')
        : t('map.structure.missing');
  const body =
    status === 'unavailable'
      ? t(`map.structure.${reason}Body`)
      : status === 'invalid'
        ? t('map.structure.invalidBody')
        : t('map.structure.missingBody');
  return (
    <div
      className={styles.state}
      data-error={status === 'invalid'}
      role={status === 'invalid' ? 'alert' : undefined}
    >
      <EmptyState
        icon={status === 'invalid' ? 'exclamation' : 'nodes'}
        title={title}
        titleAs="h2"
        body={body}
        className={styles.repoState}
      />
      {status === 'missing' ? (
        <>
          <Fold summary={t('map.structure.sampleTitle')}>
            <pre>{t('map.structure.sample')}</pre>
          </Fold>
          <p>{t('map.structure.missingHelp')}</p>
          <ButtonLink to={`/p/${projectKey}`} variant="secondary">
            {t('map.structure.board')}
          </ButtonLink>
        </>
      ) : null}
      {status === 'invalid' ? (
        <>
          <pre className={styles.problem}>{repo?.problem}</pre>
          <p>{t('map.structure.invalidHelp')}</p>
        </>
      ) : null}
      {status === 'unavailable' && reason !== 'not_allowed' ? (
        <Button variant="secondary" onClick={retry}>
          {t('app.retry')}
        </Button>
      ) : null}
    </div>
  );
}

export function StructureView() {
  const { key } = useProject();
  useDocumentTitle(t('map.title'));
  const query = useStructure(key);
  const { model, pipeline } = useBoardModel();
  const now = useNow(true, 60_000);
  const [params, setParams] = useSearchParams();
  const drawerOpen = Boolean(useMatch('/p/:projectKey/map/tasks/:taskKey/*'));
  const mobile = useIsMobile();
  const trigger = useRef<FocusOrigin | null>(null);
  const sideRef = useRef<HTMLElement | null>(null);
  const panelHeading = useRef<HTMLHeadingElement | null>(null);
  const listHeading = useRef<HTMLHeadingElement | null>(null);
  const focusPanelPending = useRef(false);
  const restoreFocusPending = useRef(false);
  const landscape = useRef<HTMLDivElement | null>(null);
  const repo = query.data?.repos.find((r) => r.repo === params.get('repo')) ?? query.data?.repos[0];
  const map = repo?.status === 'ok' ? repo.map : null;
  const all = params.get('cards') === 'all';
  const cardKey = params.get('card');
  const moduleId = !cardKey ? params.get('module') : null;
  const outside = !cardKey && !moduleId && params.get('outside') === '1';
  const selected = Boolean(cardKey || moduleId || outside);
  const states = useMemo(() => {
    const result = new Map<string, MapState | null>();
    for (const { task, state } of model?.entries ?? [])
      result.set(
        task.key,
        mapStateOf(state.phase, isStale(task, state.phase, pipeline?.stageById.get(task.stageId)?.kind, now)),
      );
    return result;
  }, [model, pipeline, now]);
  const cards = sortCards(
    (repo?.cards ?? []).filter((c) => all || c.source !== 'merge'),
    states,
  );
  const card = cards.find((c) => c.taskKey === cardKey);
  const module = map?.modules.find((m) => m.id === moduleId);
  const clashes = sharedModules(repo?.cards ?? []);
  const relatedCards = (id: string) => cards.filter((c) => c.modules.some((m) => m.id === id));
  const workers = (id: string) =>
    (repo?.cards ?? []).filter((c) => c.source !== 'merge' && c.modules.some((m) => m.id === id));
  const nameOf = (id: string) => map?.modules.find((m) => m.id === id)?.name ?? id;
  const countOf = (id: string) => repo?.sizes.find((s) => s.id === id)?.files ?? 0;
  const maxSize = Math.max(0, ...(repo?.sizes.map((s) => s.files) ?? []));
  const clearParams = (next: URLSearchParams) => {
    next.delete('card');
    next.delete('module');
    next.delete('outside');
  };
  const clear = () => {
    const next = new URLSearchParams(params);
    clearParams(next);
    setParams(next);
    restoreFocusPending.current = true;
  };
  const select = (kind: 'card' | 'module' | 'outside', value: string) => {
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if ((!selected || !trigger.current) && active) {
      if (active.dataset.cardRow) trigger.current = { kind: 'card', id: active.dataset.cardRow };
      else if (active.dataset.module || active.dataset.moduleLink)
        trigger.current = { kind: 'module', id: active.dataset.module ?? active.dataset.moduleLink! };
      else if (active.hasAttribute('data-outside')) trigger.current = { kind: 'outside', id: '1' };
    }
    const next = new URLSearchParams(params);
    const same = params.get(kind) === value;
    focusPanelPending.current = !same && Boolean(active && sideRef.current?.contains(active));
    if (same) restoreFocusPending.current = true;
    clearParams(next);
    if (!same) next.set(kind, value);
    setParams(next);
  };
  const returnFocusTarget = () => {
    const origin = trigger.current;
    if (origin?.kind === 'card')
      return (
        [...(sideRef.current?.querySelectorAll<HTMLElement>('[data-card-row]') ?? [])].find(
          (element) => element.dataset.cardRow === origin.id,
        ) ?? listHeading.current
      );
    if (origin?.kind === 'module')
      return (
        [...(landscape.current?.querySelectorAll<HTMLElement>('[data-module]') ?? [])].find(
          (element) => element.dataset.module === origin.id,
        ) ?? listHeading.current
      );
    if (origin?.kind === 'outside')
      return landscape.current?.querySelector<HTMLElement>('[data-outside]') ?? listHeading.current;
    return listHeading.current;
  };
  // Query changes replace panel buttons; resolve the new DOM nodes only after the render.
  useEffect(() => {
    if (restoreFocusPending.current && !selected) {
      returnFocusTarget()?.focus();
      restoreFocusPending.current = false;
      focusPanelPending.current = false;
    } else if (focusPanelPending.current && selected && !mobile && !drawerOpen) {
      panelHeading.current?.focus();
      focusPanelPending.current = false;
    }
  });
  useEffect(() => {
    if (!query.data) return;
    const invalid = cardKey ? !card : moduleId ? !module : outside ? !repo?.unmapped.count : false;
    if (invalid) {
      if (document.activeElement === document.body || sideRef.current?.contains(document.activeElement))
        restoreFocusPending.current = true;
      const next = new URLSearchParams(params);
      clearParams(next);
      setParams(next, { replace: true });
    }
  }, [query.data, cardKey, moduleId, outside, card, module, repo, params, setParams]);
  useEffect(() => {
    if (!selected || mobile || drawerOpen) return;
    const handler = (event: KeyboardEvent) => {
      if (isPageEscape(event)) {
        event.preventDefault();
        clear();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  });
  const affected = new Set(
    card?.modules.map((m) => m.id) ??
      (module
        ? [
            module.id,
            ...(map?.links.flatMap((l) =>
              l.from === module.id ? [l.to] : l.to === module.id ? [l.from] : [],
            ) ?? []),
          ]
        : []),
  );
  const roads = useMemo(() => {
    const links = map?.links ?? [];
    if (card) {
      const ids = new Set(card.modules.map((m) => m.id));
      return links.filter((l) => ids.has(l.from) && ids.has(l.to));
    }
    if (module) return links.filter((l) => l.from === module.id || l.to === module.id);
    if (outside || links.length > 60 || mobile) return [];
    return links;
  }, [map, card, module, outside, mobile]);
  const base = `/p/${key}/map`;
  const search = params.size ? `?${params}` : '';
  const drawerBase = useMemo(
    () => ({
      close: base + search,
      card: (taskKey: string, sub?: string) => `${base}/tasks/${taskKey}${sub ? `/${sub}` : ''}${search}`,
    }),
    [base, search],
  );
  const moduleButton = (id: string, detail?: string) => (
    <button type="button" data-module-link={id} className={styles.row} onClick={() => select('module', id)}>
      {nameOf(id)}
      {detail ? <small>{detail}</small> : null}
    </button>
  );
  const cardRow = (c: StructureCard, count?: number) => {
    const state = states.get(c.taskKey);
    return (
      <button
        type="button"
        className={styles.cardRow}
        data-card-row={c.taskKey}
        data-merged={c.source === 'merge'}
        aria-pressed={cardKey === c.taskKey}
        onClick={() => select('card', c.taskKey)}
      >
        {state ? <StateMark state={state} /> : <span />}
        <span className={styles.key}>{c.taskKey}</span>
        {c.modules.some((m) => clashes.includes(m.id)) ? (
          <span className={styles.tag}>{t('map.structure.clashTag')}</span>
        ) : null}
        <b>{model?.byKey.get(c.taskKey)?.task.title ?? c.taskKey}</b>
        <small>
          {count !== undefined ? filesText(count) : c.modules.map((m) => nameOf(m.id)).join(' · ')}
        </small>
      </button>
    );
  };
  const examples = (paths: string[]) => (
    <ul className={styles.examples}>
      {paths.slice(0, 10).map((path) => (
        <li key={path}>
          <code>{path}</code>
        </li>
      ))}
    </ul>
  );
  const clashBox = (id: string, current?: string) =>
    clashes.includes(id) ? (
      <p className={styles.clashBox}>
        {current
          ? t('map.structure.cardClash', {
              module: nameOf(id),
              keys: joinNames(
                workers(id)
                  .filter((c) => c.taskKey !== current)
                  .map((c) => c.taskKey),
              ),
            })
          : t('map.structure.moduleClash', {
              keys: joinNames(workers(id).map((c) => c.taskKey)),
            })}
      </p>
    ) : null;
  const cardList = (
    <>
      <h2 ref={listHeading} tabIndex={-1}>
        {t('map.structure.list')}
      </h2>
      <p>{t('map.structure.hint')}</p>
      {cards.length ? (
        <ul className={styles.list}>
          {cards.map((c) => (
            <li key={c.taskKey}>{cardRow(c)}</li>
          ))}
        </ul>
      ) : (
        <p>{t('map.structure.emptyCards')}</p>
      )}
    </>
  );
  const panel = card ? (
    <>
      {states.get(card.taskKey) ? (
        <span className={styles.chip}>{t(`map.structure.${states.get(card.taskKey)!}`)}</span>
      ) : null}
      {(() => {
        const entry = model?.byKey.get(card.taskKey);
        return entry &&
          isStale(entry.task, entry.state.phase, pipeline?.stageById.get(entry.task.stageId)?.kind, now) ? (
          <span className={styles.chip}>
            {t('map.structure.stale', { days: staleDays(entry.task, now) })}
          </span>
        ) : null;
      })()}
      <p className={styles.key}>{card.taskKey}</p>
      <h2 ref={panelHeading} tabIndex={-1}>
        {model?.byKey.get(card.taskKey)?.task.title ?? card.taskKey}
      </h2>
      <p>
        {t(`map.structure.${card.source}`)} · {t('map.structure.changed', { count: card.files })}
      </p>
      <h3>{t('map.structure.affected')}</h3>
      <ul className={styles.list}>
        {card.modules.map((m) => (
          <li key={m.id}>
            {moduleButton(m.id, filesText(m.files))}
            {clashBox(m.id, card.taskKey)}
          </li>
        ))}
      </ul>
      {card.unmapped.length ? (
        <>
          <h3>{t('map.structure.outsideTitle')}</h3>
          {examples(card.unmapped)}
        </>
      ) : null}
      {card.truncated ? <p>{t('map.structure.cardTruncated')}</p> : null}
      <ButtonLink to={drawerBase.card(card.taskKey)} variant="primary">
        {t('map.structure.open')}
      </ButtonLink>
    </>
  ) : module ? (
    <>
      <div className={styles.chips}>
        <span className={styles.chip}>{t(`map.structure.${module.kind}`)}</span>
        <span className={styles.chip}>{map?.areas.find((a) => a.id === module.area)?.name}</span>
        {module.kind !== 'external' ? (
          <span className={styles.chip}>{filesText(countOf(module.id))}</span>
        ) : null}
      </div>
      <h2 ref={panelHeading} tabIndex={-1}>
        {module.name}
      </h2>
      <p>{module.summary}</p>
      {clashBox(module.id)}
      {(['outgoing', 'incoming'] as const).map((direction) => {
        const links =
          map?.links.filter((l) => (direction === 'outgoing' ? l.from === module.id : l.to === module.id)) ??
          [];
        return (
          <section key={direction}>
            <h3>{t(`map.structure.${direction}`)}</h3>
            {links.length ? (
              <ul className={styles.list}>
                {links.map((l) => (
                  <li key={`${l.from}:${l.to}`}>
                    {moduleButton(direction === 'outgoing' ? l.to : l.from, l.label)}
                  </li>
                ))}
              </ul>
            ) : (
              <p>{t('map.structure.emptyLinks')}</p>
            )}
          </section>
        );
      })}
      <h3>{t('map.structure.onModule')}</h3>
      {relatedCards(module.id).length ? (
        <ul className={styles.list}>
          {relatedCards(module.id).map((c) => (
            <li key={c.taskKey}>{cardRow(c, c.modules.find((m) => m.id === module.id)?.files)}</li>
          ))}
        </ul>
      ) : (
        <p>{t(all ? 'map.structure.emptyModuleAll' : 'map.structure.emptyModule')}</p>
      )}
    </>
  ) : outside ? (
    <>
      <h2 ref={panelHeading} tabIndex={-1}>
        {t('map.structure.outsideTitle')}
      </h2>
      <p>{t('map.structure.outsideBody')}</p>
      <h3>{t('map.structure.examples')}</h3>
      {examples(repo?.unmapped.examples ?? [])}
    </>
  ) : (
    cardList
  );
  const announcement = card
    ? t('map.structure.selectedCard', { key: card.taskKey, count: card.modules.length })
    : module
      ? t('map.structure.selectedModule', { name: module.name })
      : outside
        ? t('map.structure.selectedOutside')
        : '';
  return (
    <DrawerBaseContext.Provider value={drawerBase}>
      <main className={styles.page} aria-busy={query.isPending}>
        <header>
          <h1>{t('map.title')}</h1>
          {query.isPending ? (
            <div className={styles.subtitleSkeleton} />
          ) : map ? (
            <p>
              {t('map.structure.summary', {
                modules: map.modules.length,
                working: repo!.cards.filter((c) => c.source !== 'merge').length,
              })}
              {clashes.length ? t('map.structure.clashes', { count: clashes.length }) : ''}
            </p>
          ) : null}
        </header>
        {query.data && query.data.repos.length > 1 ? (
          <SegmentedControl
            className={styles.repos}
            label={t('map.structure.repo')}
            value={repo?.repo ?? ''}
            options={query.data.repos.map((r) => ({
              value: r.repo,
              label: r.repo,
              ariaLabel: r.status === 'ok' ? r.repo : `${r.repo}, ${t('map.structure.noMap')}`,
              indicator: r.status !== 'ok',
            }))}
            onChange={(value) => {
              const next = new URLSearchParams(params);
              clearParams(next);
              next.set('repo', value);
              setParams(next);
            }}
          />
        ) : null}
        {query.isPending ? (
          <div className={styles.layout}>
            <div>
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className={styles.skeleton} />
              ))}
            </div>
            <aside>
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className={styles.skeleton} />
              ))}
            </aside>
          </div>
        ) : query.isError && !query.data ? (
          <ErrorState
            error={query.error}
            message={t('map.structure.error')}
            onRetry={() => void query.refetch()}
          />
        ) : !map ? (
          <RepoState repo={repo} projectKey={key} retry={() => void query.refetch()} />
        ) : (
          <>
            <div className={styles.toolbar}>
              <SegmentedControl
                label={t('map.structure.cards')}
                value={all ? 'all' : 'ongoing'}
                options={[
                  { value: 'ongoing', label: t('map.structure.ongoing') },
                  { value: 'all', label: t('map.structure.all') },
                ]}
                onChange={(value) => {
                  const next = new URLSearchParams(params);
                  if (value === 'all') next.set('cards', 'all');
                  else next.delete('cards');
                  setParams(next);
                }}
              />
              <ul className={styles.legend} aria-label={t('map.structure.legend')}>
                {STRUCTURE_MODULE_KINDS.map((kind) => (
                  <li key={kind}>
                    <span className={styles.shape} data-kind={kind} aria-hidden="true" />
                    {t(`map.structure.${kind}`)}
                  </li>
                ))}
                {MAP_STATE_ORDER.map((state) => (
                  <li key={state}>
                    <StateMark state={state} />
                    {t(`map.structure.${state}`)}
                  </li>
                ))}
              </ul>
            </div>
            {repo?.truncated ? <p className={styles.notice}>{t('map.structure.truncated')}</p> : null}
            <div className={styles.layout}>
              <div className={styles.landscape} ref={landscape}>
                <StructureRoads
                  container={landscape}
                  links={roads}
                  active={Boolean(card || module)}
                  layout={`${repo?.readAt}:${all}`}
                />
                {map.areas.map((area, index) => (
                  <section
                    className={styles.area}
                    key={area.id}
                    aria-labelledby={`area-${area.id}`}
                    style={
                      {
                        '--area-bg': `var(--column-${colors[index % colors.length]}-bg)`,
                        '--area-fg': `var(--column-${colors[index % colors.length]}-fg)`,
                      } as CSSProperties
                    }
                  >
                    <div className={styles.areaHead}>
                      <h2 id={`area-${area.id}`}>{area.name}</h2>
                      {area.summary ? <p>{area.summary}</p> : null}
                    </div>
                    <ul className={styles.plots}>
                      {map.modules
                        .filter((m) => m.area === area.id)
                        .map((m) => {
                          const size = m.kind === 'external' ? 3 : moduleSize(countOf(m.id), maxSize),
                            attached = relatedCards(m.id),
                            clash = clashes.includes(m.id);
                          return (
                            <li
                              key={m.id}
                              data-size={size}
                              style={
                                {
                                  '--plot-width': `${sizes[size]}px`,
                                } as CSSProperties
                              }
                            >
                              <button
                                type="button"
                                data-module={m.id}
                                data-kind={m.kind}
                                data-dim={selected && !affected.has(m.id)}
                                data-lit={Boolean(card && affected.has(m.id))}
                                data-clash={clash}
                                aria-pressed={moduleId === m.id}
                                className={styles.plot}
                                onClick={() => select('module', m.id)}
                                aria-label={t('map.structure.moduleAria', {
                                  name: m.name,
                                  kind: t(`map.structure.${m.kind}`),
                                  files:
                                    m.kind === 'external'
                                      ? t('map.structure.externalMeta')
                                      : filesText(countOf(m.id)),
                                  cards: attached.length
                                    ? t('map.structure.cardCount', { count: attached.length })
                                    : t('map.structure.noCards'),
                                  clash: clash ? t('map.structure.clashAria') : '',
                                })}
                              >
                                <span className={styles.hex} aria-hidden="true" />
                                <strong>{m.name}</strong>
                                <small>
                                  {m.kind === 'external'
                                    ? t('map.structure.externalMeta')
                                    : filesText(countOf(m.id))}
                                </small>
                                {attached.length ? (
                                  <span className={styles.pins} aria-hidden="true">
                                    {attached.slice(0, 4).map((c) => {
                                      const state = states.get(c.taskKey);
                                      return state ? (
                                        <span key={c.taskKey} data-merged={c.source === 'merge'}>
                                          <StateMark state={state} />
                                        </span>
                                      ) : null;
                                    })}
                                    {attached.length > 4 ? <small>+{attached.length - 4}</small> : null}
                                  </span>
                                ) : null}
                                {clash ? (
                                  <span className={styles.clash} aria-hidden="true">
                                    {t('map.structure.clash', { count: workers(m.id).length })}
                                  </span>
                                ) : null}
                                {card?.modules.some((c) => c.id === m.id) ? (
                                  <span className={styles.fileBadge} aria-hidden="true">
                                    {filesText(card.modules.find((c) => c.id === m.id)!.files)}
                                  </span>
                                ) : null}
                              </button>
                            </li>
                          );
                        })}
                    </ul>
                  </section>
                ))}
                {repo?.unmapped.count ? (
                  <button
                    type="button"
                    data-outside=""
                    className={styles.outside}
                    aria-pressed={outside}
                    onClick={() => select('outside', '1')}
                  >
                    {t('map.structure.outside', { count: repo.unmapped.count })}
                  </button>
                ) : null}
              </div>
              <aside ref={sideRef} className={styles.side} aria-label={t('map.structure.details')}>
                {selected && !mobile ? (
                  <button type="button" className={styles.back} onClick={clear}>
                    <Icon name="chevronLeft" size={14} />
                    {t('map.structure.back')}
                  </button>
                ) : null}
                {mobile ? cardList : panel}
              </aside>
            </div>
            {mobile ? (
              <Dialog
                open={selected && !drawerOpen}
                onClose={clear}
                title={t('map.structure.details')}
                size="sm"
                returnFocusFallback={returnFocusTarget}
              >
                <div className={styles.panel}>{panel}</div>
              </Dialog>
            ) : null}
          </>
        )}
        <div className="visually-hidden" aria-live="polite">
          {announcement}
        </div>
      </main>
      <Outlet />
    </DrawerBaseContext.Provider>
  );
}
