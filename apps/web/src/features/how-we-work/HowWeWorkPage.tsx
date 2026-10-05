import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { teamMap } from '@projectman/shared';
import type { TeamMap } from '@projectman/shared';
import { useConfig, useRoles } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { NotFoundPage } from '../../app/NotFoundPage';
import { Button, ButtonLink } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { PageHeader } from '../../components/PageHeader';
import { ErrorState } from '../../components/States';
import { t } from '../../i18n/t';
import { useDocumentTitle, useMediaQuery } from '../../lib/hooks';
import { buildDetail, idleDetail } from './Details';
import { DetailsAside, DetailsDialogBody } from './DetailsPanel';
import { FlowSection } from './FlowSection';
import { LabelsSection } from './LabelsSection';
import { MapProvider } from './MapContext';
import type { MapView } from './MapContext';
import { changedStageIds, parseShow, showValue } from './model';
import type { ShowTarget } from './model';
import { RulesSection } from './rules';
import { TeamSection } from './TeamSection';
import styles from './HowWeWork.module.css';

/** The details sit beside the page from this width (the page is the window minus the rail); narrower they open as a dialog. */
const WIDE_QUERY = '(min-width: 1180px)';
const FLASH_MS = 1400;

/** "Hogyan dolgozunk": how a card moves through this project's team, drawn from its live configuration. A client gets no such page. */
export function HowWeWorkPage() {
  const { can } = useProject();
  if (!can.readConfig) return <NotFoundPage message={t('app.notFound')} />;
  return <HowWeWork />;
}

function HowWeWork() {
  const { key, can } = useProject();
  const config = useConfig(key, can.readConfig);
  const roles = useRoles(key);
  const data = config.data;
  const map = useMemo(() => (data ? teamMap(data.config) : null), [data]);
  useDocumentTitle(t('howWeWork.title'), data?.config.project.name);
  const flashed = useFlash(map);
  const { selected, select, close } = useSelection();
  const wide = useMediaQuery(WIDE_QUERY);

  const view = useMemo<MapView | null>(() => {
    if (!data || !map) return null;
    const stageNames = new Map(data.config.pipeline.stages.map((stage) => [stage.id, stage.name]));
    const members = new Map(data.config.team.members.map((member) => [member.handle, member]));
    const roleNames = new Map((roles.data?.roles ?? []).map((role) => [role.id, role.name]));
    return {
      projectKey: key,
      map,
      config: data.config,
      labels: map.labels.map((entry) => ({ ...entry.label, holders: entry.holders })),
      canEdit: can.manageTeam,
      roleName: (id) => roleNames.get(id) ?? id,
      selected,
      select,
      stageName: (id) => stageNames.get(id) ?? id,
      member: (handle) => members.get(handle),
    };
  }, [data, map, roles.data, key, can.manageTeam, selected, select]);

  const detail = view ? (selected ? buildDetail(selected, view) : idleDetail()) : null;

  return (
    <div className={styles.page}>
      <PageHeader className={styles.pageHead} title={t('howWeWork.title')} subtitle={t('howWeWork.subtitle')}>
        {view?.canEdit ? (
          <ButtonLink to={`/p/${key}/settings`} variant="secondary" size="sm" icon="settings">
            {t('howWeWork.editInSettings')}
          </ButtonLink>
        ) : null}
      </PageHeader>
      {view && detail && map ? (
        <MapProvider value={view}>
          <div className={styles.layout}>
            <div className={styles.content}>
              <section className={styles.section} aria-labelledby="how-we-work-flow">
                <div className={styles.sectionHead}>
                  <h2 id="how-we-work-flow">{t('howWeWork.sections.flow')}</h2>
                  <LegendButton selected={selected} onOpen={select} />
                </div>
                <p className={styles.sectionSub}>{t('howWeWork.sections.flowHint')}</p>
                <FlowSection flashed={flashed} />
              </section>
              <section className={styles.section} aria-labelledby="how-we-work-rules">
                <div className={styles.sectionHead}>
                  <h2 id="how-we-work-rules">{t('howWeWork.sections.rules')}</h2>
                </div>
                <RulesSection />
              </section>
              <section className={styles.section} aria-labelledby="how-we-work-team">
                <div className={styles.sectionHead}>
                  <h2 id="how-we-work-team">{t('howWeWork.sections.team')}</h2>
                </div>
                <TeamSection />
              </section>
              <section className={styles.section} aria-labelledby="how-we-work-labels">
                <div className={styles.sectionHead}>
                  <h2 id="how-we-work-labels">{t('howWeWork.sections.labels')}</h2>
                </div>
                <p className={styles.sectionSub}>{t('howWeWork.sections.labelsHint')}</p>
                <LabelsSection />
              </section>
            </div>
            {wide ? (
              <aside className={styles.aside} aria-label={t('howWeWork.detailsRegion')} aria-live="polite">
                <DetailsAside detail={detail} onClose={selected ? close : undefined} />
              </aside>
            ) : null}
          </div>
          {!wide && selected ? (
            <Dialog open onClose={close} title={detail.title} size="sm">
              <DetailsDialogBody detail={detail} />
            </Dialog>
          ) : null}
        </MapProvider>
      ) : config.isError ? (
        <ErrorState error={config.error} onRetry={() => void config.refetch()} className={styles.errorBox} />
      ) : (
        <div className={styles.skel} role="status" aria-busy="true">
          <span className="visually-hidden">{t('app.loading')}</span>
          {[0, 1, 2, 3, 4].map((row) => (
            <div key={row} className={styles.skelRow} />
          ))}
        </div>
      )}
    </div>
  );
}

function LegendButton({
  selected,
  onOpen,
}: {
  selected: ShowTarget | null;
  onOpen: (target: ShowTarget, opener: HTMLElement) => void;
}) {
  return (
    <Button
      size="sm"
      variant="ghost"
      aria-pressed={selected?.kind === 'legend'}
      data-show="legend"
      onClick={(event) => onOpen({ kind: 'legend' }, event.currentTarget)}
    >
      {t('howWeWork.legendButton')}
    </Button>
  );
}

/** The stages that changed since the map last drew: they flash for a moment, so a live change is easy to find. */
function useFlash(map: TeamMap | null): ReadonlySet<string> {
  const previous = useRef<TeamMap | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [flashed, setFlashed] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    if (!map) return;
    const changed = changedStageIds(previous.current, map);
    previous.current = map;
    if (changed.size === 0) return;
    clearTimeout(timer.current);
    setFlashed(changed);
    timer.current = setTimeout(() => setFlashed(new Set()), FLASH_MS);
  }, [map]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return flashed;
}

/**
 * The item on show lives in `?show=`, so a link can point at it. Closing it (the button, Esc, the
 * dialog) puts the focus back on what opened it.
 */
function useSelection() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('show');
  const selected = useMemo(() => parseShow(raw), [raw]);
  const value = selected ? showValue(selected) : null;
  const opener = useRef<HTMLElement | null>(null);
  const lastValue = useRef<string | null>(null);

  const write = useCallback(
    (next: string | null) => {
      setParams(
        (current) => {
          const copy = new URLSearchParams(current);
          if (next === null) copy.delete('show');
          else copy.set('show', next);
          return copy;
        },
        { replace: true },
      );
    },
    [setParams],
  );
  const select = useCallback(
    (target: ShowTarget, from?: HTMLElement | null) => {
      // Moving from one item to another inside the panel keeps the first opener.
      if (value === null && from) opener.current = from;
      write(showValue(target));
    },
    [value, write],
  );
  const close = useCallback(() => write(null), [write]);

  useEffect(() => {
    if (value !== null) {
      lastValue.current = value;
      return;
    }
    if (lastValue.current === null) return;
    const shown = lastValue.current;
    lastValue.current = null;
    const target = opener.current?.isConnected
      ? opener.current
      : [...document.querySelectorAll<HTMLElement>('[data-show]')].find(
          (element) => element.dataset.show === shown,
        );
    target?.focus();
    opener.current = null;
  }, [value]);

  useEffect(() => {
    if (value === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [value, close]);

  return { selected, select, close };
}
