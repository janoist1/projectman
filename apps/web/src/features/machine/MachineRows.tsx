import { Fragment, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { MachineSessionRow, OrphanProcessRow, OrphanStopOutcome } from '@projectman/shared';
import { useStopSession } from '../../api/queries';
import { Avatar } from '../../components/Avatar';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { MiniMeter } from '../../components/MiniMeter';
import { useToast } from '../../components/toastContext';
import { formatDuration, formatMemory, formatPercent, formatStamp } from '../../i18n/format';
import { t } from '../../i18n/t';
import { percent, workName } from './machineView';
import styles from './Machine.module.css';

export type Confirmation = { id: string; restore: () => void } | null;
export type Controls = {
  confirm: Confirmation;
  ask: (id: string, restore: () => void) => void;
  cancel: () => void;
  expanded: Set<string>;
  toggle: (id: string) => void;
};

export function Confirm({
  title,
  body,
  all = false,
  cancel,
  stop,
}: {
  title: string;
  body?: string;
  all?: boolean;
  cancel: () => void;
  stop: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div className={styles.confirm}>
      <div>
        <strong>{title}</strong>
        {body && <p>{body}</p>}
      </div>
      <div className={styles.actions}>
        <Button ref={ref} size="md" onClick={cancel}>
          {t('common.cancel')}
        </Button>
        <Button size="md" variant="dangerSolid" icon="stop" onClick={stop}>
          {t(all ? 'machine.stopAll' : 'session.stop')}
        </Button>
      </div>
    </div>
  );
}

function Work({ row, onClose }: { row: MachineSessionRow; onClose: () => void }) {
  return (
    <span className={styles.work}>
      <span className={styles.project}>{row.projectKey}</span>{' '}
      {row.workItem.type === 'task' ? (
        <Link onClick={onClose} to={`/p/${row.projectKey}/tasks/${row.workItem.taskKey}`}>
          {row.workItem.taskKey} {row.taskTitle}
        </Link>
      ) : (
        workName(row.workItem)
      )}
    </span>
  );
}

export function Usage({
  cpu,
  memory,
  total,
  delayed,
}: {
  cpu: number | null;
  memory: number | null;
  total: number | null;
  delayed: boolean;
}) {
  return (
    <>
      <td className={styles.numeric}>
        <MiniMeter
          label=""
          ariaLabel={t('machine.cpu')}
          value={delayed ? null : cpu}
          level={delayed ? null : 'ok'}
          pauseAbove={0}
        />
      </td>
      <td className={styles.numeric}>
        <MiniMeter
          label=""
          ariaLabel={t('machine.memory')}
          value={delayed ? null : percent(memory, total)}
          displayValue={formatMemory(delayed ? null : memory)}
          level="ok"
          pauseAbove={0}
        />
      </td>
    </>
  );
}

export function SessionRow({
  row,
  controls,
  now,
  delayed,
  total,
  onClose,
  leaving,
  phone,
}: {
  row: MachineSessionRow;
  controls: Controls;
  now: number;
  delayed: boolean;
  total: number | null;
  onClose: () => void;
  leaving: boolean;
  phone: boolean;
}) {
  const stop = useStopSession(row.projectKey);
  const button = useRef<HTMLButtonElement>(null);
  const name = row.member?.displayName ?? row.memberHandle;
  const work = workName(row.workItem);
  const expanded = controls.expanded.has(row.sessionId);
  const confirming = controls.confirm?.id === row.sessionId;
  const [error, setError] = useState(false);
  const toast = useToast();
  const state = t(`sessionState.${row.paused ? 'paused' : row.state}`);
  const submit = () => {
    controls.cancel();
    setError(false);
    stop.mutate(row.sessionId, {
      onSuccess: () => {
        toast.show(t('session.stopped'), 'ok');
      },
      onError: () => setError(true),
    });
  };
  return (
    <Fragment>
      {confirming ? (
        <tr>
          <td colSpan={6}>
            <Confirm
              title={t('machine.confirmSession', { name, work })}
              body={t('session.stopBody')}
              cancel={controls.cancel}
              stop={submit}
            />
          </td>
        </tr>
      ) : (
        <tr
          data-session-id={row.sessionId}
          onClick={(event) => {
            if (phone && !(event.target instanceof Element && event.target.closest('button,a')))
              controls.toggle(row.sessionId);
          }}
          className={leaving ? styles.leaving : stop.isPending ? styles.stopping : undefined}
        >
          <td>
            <div className={styles.who}>
              <button
                className={styles.expand}
                aria-label={t('machine.processes', { name })}
                aria-expanded={expanded}
                onClick={() => controls.toggle(row.sessionId)}
              >
                <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={14} />
              </button>
              <Avatar
                member={row.member}
                handle={row.member ? row.memberHandle : row.memberHandle.slice(0, 1)}
                size="sm"
              />
              <strong>{name}</strong>
            </div>
            <Work row={row} onClose={onClose} />
          </td>
          <td className={styles.state}>
            <span>
              <i data-state={row.paused ? 'paused' : row.state} />
              {state}
            </span>
            <small>
              {t('machine.since', { duration: formatDuration(now - Date.parse(row.stateSince)) })}
            </small>
          </td>
          <td className={styles.age}>
            {delayed || row.processStartedAt === null
              ? t('planUsage.unknown')
              : formatDuration(now - Date.parse(row.processStartedAt))}
          </td>
          <Usage cpu={row.cpuPercent} memory={row.memoryBytes} total={total} delayed={delayed} />
          <td className={styles.stopCell}>
            {stop.isPending ? (
              t('machine.stopping')
            ) : (
              <Button
                ref={button}
                size="sm"
                variant="ghost"
                icon="stop"
                aria-label={t('machine.stopLabel', { name, work })}
                onClick={() => controls.ask(row.sessionId, () => button.current?.focus())}
              >
                <span className={styles.stopText}>{t('session.stop')}</span>
              </Button>
            )}
          </td>
        </tr>
      )}
      {error && (
        <tr>
          <td colSpan={6} className={styles.error}>
            {t('machine.stopFailed')}
          </td>
        </tr>
      )}
      {expanded && (
        <tr>
          <td colSpan={6} className={styles.details}>
            <ul>
              {row.top.map((process) => (
                <li key={process.pid}>
                  <code>{process.name}</code>
                  <span>
                    {delayed || process.cpuPercent === null
                      ? t('planUsage.unknown')
                      : formatPercent(process.cpuPercent)}{' '}
                    · {formatMemory(delayed ? null : process.memoryBytes)}
                  </span>
                </li>
              ))}
            </ul>
            {row.processCount !== null && row.processCount > row.top.length && (
              <p>{t('machine.more', { count: row.processCount - row.top.length })}</p>
            )}
            <p>
              {t('machine.started', {
                time: row.processStartedAt ? formatStamp(row.processStartedAt) : t('planUsage.unknown'),
              })}{' '}
              ·{' '}
              {t('machine.processInfo', {
                pid: row.pid ?? t('planUsage.unknown'),
                count: row.processCount ?? t('planUsage.unknown'),
              })}
            </p>
            <Link onClick={onClose} to={`/p/${row.projectKey}/sessions/${row.sessionId}`}>
              {t('machine.openSession')} →
            </Link>
          </td>
        </tr>
      )}
    </Fragment>
  );
}

export function OrphanRow({
  row,
  controls,
  now,
  total,
  delayed,
  outcome,
  pending,
  stop,
  leaving,
  phone,
}: {
  row: OrphanProcessRow;
  controls: Controls;
  now: number;
  total: number | null;
  delayed: boolean;
  outcome?: OrphanStopOutcome;
  pending: boolean;
  stop: () => void;
  leaving: boolean;
  phone: boolean;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const id = `orphan:${row.pid}:${row.startedAt}`;
  const origin = row.origin;
  const source = origin
    ? origin.endedAt
      ? t('machine.origin', {
          name: origin.member?.displayName ?? origin.memberHandle,
          work: workName(origin.workItem),
          time: formatStamp(origin.endedAt),
        })
      : t('machine.previousOrigin', {
          name: origin.member?.displayName ?? origin.memberHandle,
          work: workName(origin.workItem),
        })
    : t('machine.unknownOrigin');
  return (
    <Fragment>
      {controls.confirm?.id === id ? (
        <tr>
          <td colSpan={6}>
            <Confirm
              title={t('machine.confirmOrphan', { process: row.name })}
              body={t('machine.orphanStopBody')}
              cancel={controls.cancel}
              stop={stop}
            />
          </td>
        </tr>
      ) : (
        <tr
          className={leaving ? styles.leaving : pending ? styles.stopping : undefined}
          onClick={(event) => {
            if (phone && !(event.target instanceof Element && event.target.closest('button,a')))
              controls.toggle(id);
          }}
        >
          <td>
            <div className={styles.who}>
              <button
                className={styles.expand}
                aria-label={t('machine.processes', { name: row.name })}
                aria-expanded={controls.expanded.has(id)}
                onClick={() => controls.toggle(id)}
              >
                <Icon name={controls.expanded.has(id) ? 'chevronDown' : 'chevronRight'} size={14} />
              </button>
              <code>{row.name}</code>
            </div>
            <small>{source}</small>
          </td>
          <td className={styles.state}>{t('machine.orphan')}</td>
          <td className={styles.age}>
            {delayed ? t('planUsage.unknown') : formatDuration(now - Date.parse(row.startedAt))}
          </td>
          <Usage cpu={row.cpuPercent} memory={row.memoryBytes} total={total} delayed={delayed} />
          <td className={styles.stopCell}>
            {pending
              ? t('machine.stopping')
              : outcome !== 'refused' && (
                  <Button
                    ref={button}
                    size="sm"
                    variant="ghost"
                    icon="stop"
                    aria-label={t('machine.stopLabel', { name: row.name, work: t('machine.orphan') })}
                    onClick={() => controls.ask(id, () => button.current?.focus())}
                  >
                    <span className={styles.stopText}>{t('session.stop')}</span>
                  </Button>
                )}
          </td>
        </tr>
      )}
      {outcome && (
        <tr>
          <td colSpan={6} className={styles.error}>
            {t(
              outcome === 'refused'
                ? 'machine.refused'
                : outcome === 'failed'
                  ? 'machine.stopFailed'
                  : outcome === 'gone'
                    ? 'machine.gone'
                    : 'machine.stopped',
            )}
          </td>
        </tr>
      )}
      {controls.expanded.has(id) && (
        <tr>
          <td colSpan={6} className={styles.details}>
            <code className={styles.command} title={row.command}>
              {row.command}
            </code>
            <p>{t('machine.processInfo', { pid: row.pid, count: row.processCount })}</p>
          </td>
        </tr>
      )}
    </Fragment>
  );
}
