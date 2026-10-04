import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { machineLevels } from '@projectman/shared';
import type { MachineSessionRow, OrphanProcessRow, OrphanStopOutcome } from '@projectman/shared';
import { useMachine, useStopOrphans } from '../../api/queries';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { MiniMeter } from '../../components/MiniMeter';
import { SegmentedControl } from '../../components/SegmentedControl';
import { useToast } from '../../components/toastContext';
import { formatAgo, formatMemory } from '../../i18n/format';
import { t } from '../../i18n/t';
import { holdOrder, isDelayed, percent, sortSessions } from './machineView';
import type { MachineSort } from './machineView';
import { Confirm, Usage, SessionRow, OrphanRow } from './MachineRows';
import type { Confirmation, Controls } from './MachineRows';
import styles from './Machine.module.css';

const sessionKey = (row: MachineSessionRow) => row.sessionId;
const orphanKey = (row: OrphanProcessRow) => `${row.pid}:${row.startedAt}`;

/** Keep removed rows for one short fade; live measurements still update immediately. */
function useLeavingRows<T>(source: T[] | null | undefined, key: (row: T) => string) {
  const [view, setView] = useState<{ rows: T[]; leaving: Set<string> }>({
    rows: source ?? [],
    leaving: new Set(),
  });
  const previous = useRef(source ?? []);
  useEffect(() => {
    const rows = source ?? [];
    const live = new Set(rows.map(key));
    const removed = previous.current.filter((row) => !live.has(key(row)));
    previous.current = rows;
    setView({ rows: [...rows, ...removed], leaving: new Set(removed.map(key)) });
    if (removed.length === 0) return;
    const timer = window.setTimeout(() => setView({ rows, leaving: new Set() }), 200);
    return () => window.clearTimeout(timer);
  }, [source, key]);
  return view;
}

export function MachinePanel({
  id,
  phone,
  query,
  now,
  onClose,
  anchor,
}: {
  id: string;
  phone: boolean;
  query: ReturnType<typeof useMachine>;
  now: number;
  onClose: () => void;
  anchor: RefObject<HTMLButtonElement | null>;
}) {
  const [sort, setSort] = useState<MachineSort>('memory');
  const [ascending, setAscending] = useState(false);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [expanded, setExpanded] = useState(new Set<string>());
  const [confirm, setConfirm] = useState<Confirmation>(null);
  const [outcomes, setOutcomes] = useState<Record<string, OrphanStopOutcome>>({});
  const [pending, setPending] = useState(new Set<string>());
  const [notice, setNotice] = useState('');
  const [position, setPosition] = useState({ top: 64, right: 16 });
  const panel = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const allButton = useRef<HTMLButtonElement>(null);
  const order = useRef<string[]>([]);
  const restoreFocus = useRef<(() => void) | null>(null);
  const stop = useStopOrphans();
  const toast = useToast();
  const data = query.data;
  const sessionView = useLeavingRows(data?.sessions, sessionKey);
  const orphanView = useLeavingRows(data?.orphans, orphanKey);
  const delayed = data ? isDelayed(data, now) : false;
  const cancel = () => {
    restoreFocus.current = confirm?.restore ?? null;
    setConfirm(null);
  };
  useLayoutEffect(() => {
    if (!confirm && restoreFocus.current) {
      restoreFocus.current();
      restoreFocus.current = null;
    }
  }, [confirm]);
  const close = () => (confirm ? cancel() : onClose());
  const closeRef = useRef(close);
  closeRef.current = close;
  const controls: Controls = {
    confirm,
    ask: (id, restore) => setConfirm({ id, restore }),
    cancel,
    expanded,
    toggle: (id) =>
      setExpanded((previous) => {
        const next = new Set(previous);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
  };
  useEffect(() => {
    title.current?.focus();
    const rect = anchor.current?.getBoundingClientRect();
    if (rect)
      setPosition({
        top: rect.bottom + 8,
        right: Math.max(
          16,
          Math.min(
            window.innerWidth - rect.right,
            window.innerWidth - Math.min(780, window.innerWidth - 32) - 16,
          ),
        ),
      });
    if (phone) return;
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !panel.current?.contains(event.target) &&
        !anchor.current?.contains(event.target)
      )
        onClose();
    };
    document.addEventListener('pointerdown', outside);
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        closeRef.current();
      }
    };
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [phone, anchor, onClose]);
  useEffect(() => {
    const live = new Set([
      ...(data?.sessions.map((row) => row.sessionId) ?? []),
      ...(data?.orphans?.map((row) => `orphan:${row.pid}:${row.startedAt}`) ?? []),
    ]);
    setExpanded((previous) => {
      const next = new Set([...previous].filter((id) => live.has(id)));
      return next.size === previous.size ? previous : next;
    });
    if (confirm && confirm.id !== 'all' && !live.has(confirm.id)) setConfirm(null);
  }, [data, confirm]);
  const sorted = sortSessions(sessionView.rows, sort, ascending);
  const held = hover || focus || expanded.size > 0 || confirm !== null || pending.size > 0;
  order.current = held ? holdOrder(order.current, sorted) : sorted.map((row) => row.sessionId);
  const rows = order.current.flatMap((id) => {
    const row = sessionView.rows.find((row) => row.sessionId === id);
    return row ? [row] : [];
  });
  const chooseSort = (value: MachineSort) => {
    setAscending(sort === value ? !ascending : false);
    setSort(value);
    order.current = sortSessions(data?.sessions ?? [], value, sort === value ? !ascending : false).map(
      (row) => row.sessionId,
    );
  };
  const stopRows = (orphans: OrphanProcessRow[]) => {
    setConfirm(null);
    setNotice('');
    const key = (row: { pid: number; startedAt: string }) => `${row.pid}:${row.startedAt}`;
    setPending(new Set(orphans.map(key)));
    stop.mutate(
      { orphans: orphans.map(({ pid, startedAt }) => ({ pid, startedAt })) },
      {
        onSuccess: (result) => {
          setOutcomes((previous) => ({
            ...previous,
            ...Object.fromEntries(result.results.map((row) => [key(row), row.outcome])),
          }));
          const done = result.results.filter(
            (row) => row.outcome === 'stopped' || row.outcome === 'gone',
          ).length;
          const message =
            orphans.length > 1
              ? done === orphans.length
                ? t('machine.stoppedAll', { count: done })
                : t('machine.partial', { done, failed: orphans.length - done })
              : t(
                  result.results[0]?.outcome === 'gone'
                    ? 'machine.gone'
                    : result.results[0]?.outcome === 'stopped'
                      ? 'machine.stopped'
                      : result.results[0]?.outcome === 'refused'
                        ? 'machine.refused'
                        : 'machine.stopFailed',
                );
          setNotice(message);
          toast.show(message, done === orphans.length ? 'ok' : 'error');
        },
        onError: () => {
          setNotice(t('machine.stopFailed'));
          toast.show(t('machine.stopFailed'), 'error');
        },
        onSettled: () => setPending(new Set()),
      },
    );
  };
  const sortOptions = [
    { value: 'memory' as const, label: t('machine.memory') },
    { value: 'cpu' as const, label: t('machine.cpu') },
    { value: 'age' as const, label: t('machine.age') },
  ];
  const heading = (
    <>
      <th scope="col">{t('machine.session')}</th>
      <th scope="col">{t('machine.state')}</th>
      {(['age', 'cpu', 'memory'] as const).map((value) => (
        <th
          scope="col"
          key={value}
          aria-sort={sort === value ? (ascending ? 'ascending' : 'descending') : 'none'}
        >
          <button onClick={() => chooseSort(value)}>
            {t(`machine.${value}`)}
            {sort === value && (ascending ? ' ↑' : ' ↓')}
          </button>
        </th>
      ))}
      <th scope="col">
        <span className="visually-hidden">{t('session.stop')}</span>
      </th>
    </>
  );
  const table = (children: ReactNode, headers = false) => (
    <table className={styles.table}>
      <colgroup>
        <col className={styles.identityColumn} />
        <col className={styles.stateColumn} />
        <col className={styles.ageColumn} />
        <col />
        <col />
        <col className={styles.actionColumn} />
      </colgroup>
      {headers && (
        <thead>
          <tr>{heading}</tr>
        </thead>
      )}
      <tbody>{children}</tbody>
    </table>
  );
  const updated = data?.sampledAt ? Math.max(0, Math.floor((now - Date.parse(data.sampledAt)) / 1000)) : 0;
  const freshness = delayed
    ? t('machine.delayed', { ago: data?.sampledAt ? formatAgo(data.sampledAt) : t('planUsage.unknown') })
    : updated < 5
      ? t('machine.updatedNow')
      : t('machine.updated', { seconds: updated });
  const summary = data?.summary;
  const levels =
    summary && !delayed ? machineLevels(summary) : { cpu: null, memory: null, swap: null, overall: null };
  const body = (
    <div
      ref={panel}
      id={id}
      className={styles.content}
      onKeyDownCapture={(event) => {
        if (event.key === 'Escape' && confirm) {
          event.preventDefault();
          event.stopPropagation();
          cancel();
        }
      }}
    >
      {!phone && (
        <header className={styles.header}>
          <h2 ref={title} tabIndex={-1} id={`${id}-title`}>
            {t('machine.title')}
          </h2>
          <span className={delayed ? styles.late : styles.fresh}>{freshness}</span>
          <Button iconOnly variant="ghost" icon="close" aria-label={t('common.close')} onClick={onClose} />
        </header>
      )}
      {phone && <p className={delayed ? styles.late : styles.fresh}>{freshness}</p>}
      {query.isError ? (
        <div className={styles.empty}>
          <p>{t('machine.loadFailed')}</p>
          <Button onClick={() => void query.refetch()}>{t('app.retry')}</Button>
        </div>
      ) : !data || !summary ? (
        <div className={styles.skeleton} aria-label={t('app.loading')}>
          <div />
          <div />
          <div />
          <div />
        </div>
      ) : (
        <>
          <div className={styles.tiles}>
            {[
              {
                label: t('machine.cpu'),
                value: summary.cpuPercent,
                display: undefined,
                detail: t('machine.cores', {
                  count: delayed ? t('planUsage.unknown') : (summary.cores ?? t('planUsage.unknown')),
                }),
                level: levels.cpu,
              },
              {
                label: t('machine.memory'),
                value: percent(summary.memoryUsedBytes, summary.memoryTotalBytes),
                display: undefined,
                detail:
                  t('machine.memoryAmount', {
                    used: formatMemory(delayed ? null : summary.memoryUsedBytes),
                    total: formatMemory(delayed ? null : summary.memoryTotalBytes),
                  }) +
                  (!delayed && (summary.memoryPressure === 'warn' || summary.memoryPressure === 'critical')
                    ? ` · ${t(summary.memoryPressure === 'warn' ? 'machine.pressureHigh' : 'machine.pressureCritical')}`
                    : ''),
                level: levels.memory,
              },
              {
                label: t('machine.swap'),
                value: percent(summary.swapUsedBytes, summary.memoryTotalBytes),
                display: formatMemory(delayed ? null : summary.swapUsedBytes),
                detail: t('machine.swapRatio', {
                  percent:
                    delayed || percent(summary.swapUsedBytes, summary.memoryTotalBytes) === null
                      ? t('planUsage.unknown')
                      : Math.round(percent(summary.swapUsedBytes, summary.memoryTotalBytes)!),
                }),
                level: levels.swap,
              },
              {
                label: t('machine.sessions'),
                value: percent(summary.sessionsWorking, summary.sessionsRunning),
                display: delayed
                  ? t('planUsage.unknown')
                  : `${summary.sessionsWorking} / ${summary.sessionsRunning}`,
                detail: t('machine.workingRunning'),
                level: delayed ? null : ('ok' as const),
              },
            ].map((tile) => (
              <div key={tile.label} className={styles.tile} data-level={tile.level}>
                <MiniMeter
                  label={tile.label}
                  value={delayed ? null : tile.value}
                  displayValue={tile.display}
                  level={tile.level}
                  pauseAbove={0}
                />
                <small title={tile.detail}>{tile.detail}</small>
              </div>
            ))}
          </div>
          {phone && (
            <SegmentedControl
              className={styles.sort}
              label={t('machine.sort')}
              options={sortOptions}
              value={sort}
              onChange={chooseSort}
            />
          )}
          <div
            className={styles.list}
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
            onFocusCapture={() => setFocus(true)}
            onBlurCapture={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) setFocus(false);
            }}
          >
            <section>
              <h3>
                {t('machine.sessions')}{' '}
                <small>
                  {delayed
                    ? t('planUsage.unknown')
                    : t('machine.running', { count: summary.sessionsRunning })}
                </small>
              </h3>
              {rows.length === 0 ? (
                <div className={styles.empty}>
                  <strong>{t('machine.noSessions')}</strong>
                  <p>{t('machine.noSessionsBody')}</p>
                </div>
              ) : (
                table(
                  rows.map((row) => (
                    <SessionRow
                      key={row.sessionId}
                      row={row}
                      controls={controls}
                      now={now}
                      total={summary.memoryTotalBytes}
                      delayed={delayed}
                      onClose={onClose}
                      leaving={sessionView.leaving.has(row.sessionId)}
                    />
                  )),
                  true,
                )
              )}
            </section>
            <section>
              <div className={styles.sectionHead}>
                <h3>
                  {t('machine.orphans')}{' '}
                  <small>{delayed ? t('planUsage.unknown') : data.orphans?.length}</small>
                </h3>
                {data.orphans && data.orphans.length > 1 && (
                  <Button
                    ref={allButton}
                    variant="ghost"
                    size="sm"
                    disabled={stop.isPending}
                    onClick={() => controls.ask('all', () => allButton.current?.focus())}
                  >
                    {t('machine.stopAll')}
                  </Button>
                )}
              </div>
              <p className={styles.hint}>{t('machine.orphanExplanation')}</p>
              {confirm?.id === 'all' && (
                <Confirm
                  title={t('machine.confirmAll', { count: data.orphans?.length ?? 0 })}
                  all
                  cancel={cancel}
                  stop={() => stopRows(data.orphans ?? [])}
                />
              )}
              {notice && <p className={styles.hint}>{notice}</p>}
              {data.orphans === null ? (
                <p className={styles.hint}>{t('machine.processListUnavailable')}</p>
              ) : orphanView.rows.length === 0 ? (
                <p className={styles.hint}>{t('machine.noOrphans')}</p>
              ) : (
                table(
                  orphanView.rows.map((row) => (
                    <OrphanRow
                      key={`${row.pid}:${row.startedAt}`}
                      row={row}
                      controls={controls}
                      now={now}
                      total={summary.memoryTotalBytes}
                      delayed={delayed}
                      outcome={outcomes[`${row.pid}:${row.startedAt}`]}
                      pending={pending.has(`${row.pid}:${row.startedAt}`)}
                      stop={() => stopRows([row])}
                      leaving={orphanView.leaving.has(orphanKey(row))}
                    />
                  )),
                )
              )}
            </section>
            <section>
              <h3>{t('machine.others')}</h3>
              <p className={styles.hint}>{t('machine.othersExplanation')}</p>
              {data.others === null && <p className={styles.hint}>{t('machine.processListUnavailable')}</p>}
              {(data.others !== null || data.rest !== null) &&
                table(
                  <>
                    {data.others?.map((row, index) => (
                      <tr key={index}>
                        <td>
                          <code>{row.kind === 'server' ? t('machine.server') : row.name}</code>
                          {row.kind === 'server' && <small>{t('machine.instance')}</small>}
                        </td>
                        <td className={styles.state} />
                        <td className={styles.age} />
                        <Usage
                          cpu={row.cpuPercent}
                          memory={row.memoryBytes}
                          total={summary.memoryTotalBytes}
                          delayed={delayed}
                        />
                        <td className={styles.stopCell} />
                      </tr>
                    ))}
                    {data.rest && (
                      <tr>
                        <td>
                          {t('machine.rest')}
                          <small>{t('machine.restExplanation')}</small>
                        </td>
                        <td className={styles.state} />
                        <td className={styles.age} />
                        <Usage
                          cpu={data.rest.cpuPercent}
                          memory={data.rest.memoryBytes}
                          total={summary.memoryTotalBytes}
                          delayed={delayed}
                        />
                        <td className={styles.stopCell} />
                      </tr>
                    )}
                  </>,
                )}
            </section>
          </div>
          {data.closedSessions > 0 && (
            <footer className={styles.footer}>{t('machine.closed', { count: data.closedSessions })}</footer>
          )}
        </>
      )}
    </div>
  );
  if (phone)
    return (
      <Dialog open title={t('machine.title')} onClose={close} size="lg" className={styles.phoneDialog}>
        {body}
      </Dialog>
    );
  return createPortal(
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby={`${id}-title`}
      className={styles.panel}
      style={position}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          close();
        }
      }}
    >
      {body}
    </div>,
    document.body,
  );
}
