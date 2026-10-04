import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import type { PausedSession, PauseStatus, Task } from '@projectman/shared';
import { useBoard, useForcePauseInstance, useForcePauseProject } from '../../api/queries';
import { useProject, useProjectIndexes } from '../../app/contexts';
import { Avatar } from '../../components/Avatar';
import { StatusDot } from '../../components/Chip';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/toastContext';
import { formatClock, formatStamp } from '../../i18n/format';
import { t } from '../../i18n/t';
import { nameOf } from '../../lib/members';
import type { MemberIndex } from '../../lib/members';
import { useNow } from '../../lib/useNow';
import { PauseNote } from './PauseNote';
import {
  canForceNow,
  forceCountdown,
  pointExplanation,
  pointText,
  reasonText,
  sortRows,
  toolLabel,
} from './pauseView';
import styles from './PauseProgress.module.css';

/** The task a row works on: its key and title, or what kind of work it is. */
function workText(
  row: PausedSession,
  tasks: ReadonlyMap<string, Task>,
): { key: string | null; title: string } {
  const { workItem } = row;
  if (workItem.type === 'task') {
    return { key: workItem.taskKey, title: tasks.get(workItem.taskKey)?.title ?? '' };
  }
  return { key: null, title: t(`pause.progress.work.${workItem.type}`) };
}

/** What the rows name: the members and cards of the project the viewer is in (empty outside the projects). */
export interface PauseLookups {
  members: MemberIndex;
  myHandle: string | null;
  tasks: ReadonlyMap<string, Task>;
}

export const noPauseLookups: PauseLookups = { members: new Map(), myHandle: null, tasks: new Map() };

/** The lookups of the open project, for the bar inside a project. */
export function useProjectPauseLookups(): PauseLookups {
  const { key, myHandle } = useProject();
  const { members } = useProjectIndexes(key);
  const tasks = useBoard(key).data?.tasks;
  return useMemo(
    () => ({ members, myHandle, tasks: new Map((tasks ?? []).map((task) => [task.key, task])) }),
    [members, myHandle, tasks],
  );
}

function Row({ row, now, lookups }: { row: PausedSession; now: number; lookups: PauseLookups }) {
  const { members, myHandle, tasks } = lookups;
  const member = members.get(row.member);
  const work = workText(row, tasks);
  const elapsed = formatClock(now - Date.parse(row.since));
  return (
    <li className={styles.row}>
      <Avatar member={member} handle={row.member} size="sm" />
      <span className={styles.member}>{nameOf(row.member, members, myHandle)}</span>
      <Link to={`/p/${row.projectKey}/sessions/${row.sessionId}`} className={styles.work}>
        {work.key ? <span className={styles.workKey}>{work.key}</span> : null}
        {work.title ? <span className={styles.workTitle}>{work.title}</span> : null}
      </Link>
      <span className={styles.state}>
        {row.point === null ? (
          <>
            <StatusDot status="working" pulse />
            <span className={styles.stateText}>
              {t('pause.progress.stillRunning', { tool: toolLabel(row.waitingFor) })}
            </span>
            <span className={styles.elapsed}>{elapsed}</span>
          </>
        ) : (
          <>
            <Icon name="check" size={14} strokeWidth={2.4} className={styles.check} />
            <span className={styles.stateText}>{pointText(row.point, row.tool)}</span>
          </>
        )}
      </span>
    </li>
  );
}

/** Asks before the still-running steps are cut, then sends the request. */
function ForceDialog({
  open,
  onClose,
  onConfirm,
  busy,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  busy: boolean;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title={t('pause.force.title')}
      description={t('pause.force.body')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('pause.force.cancel')}
          </Button>
          <Button variant="dangerSolid" icon="stop" loading={busy} onClick={onConfirm}>
            {busy ? t('pause.force.busy') : t('pause.force.button')}
          </Button>
        </>
      }
    />
  );
}

/**
 * What the pause holds (PM-220): who has stopped and where, who still runs, and, while someone does and
 * the deadline is not over, the way to cut the running steps now.
 */
export function PauseProgress({
  pause,
  canManage,
  lookups,
}: {
  pause: PauseStatus;
  canManage: boolean;
  lookups: PauseLookups;
}) {
  const toast = useToast();
  const pausing = pause.state === 'pausing';
  const now = useNow(pausing);
  const [confirming, setConfirming] = useState(false);
  const forceProject = useForcePauseProject(pause.projectKey ?? '');
  const forceInstance = useForcePauseInstance();
  const force = pause.scope === 'instance' ? forceInstance : forceProject;

  const rows = useMemo(() => sortRows(pause.sessions), [pause.sessions]);
  const running = rows.filter((row) => row.point === null);
  const stopped = rows.filter((row) => row.point !== null);
  const countdown = forceCountdown(pause, now);
  const explanations = [
    ...new Set(
      stopped.flatMap((row) => {
        const text = row.point ? pointExplanation(row.point) : null;
        return text ? [text] : [];
      }),
    ),
  ];
  const requestedBy = pause.requestedBy ?? reasonText(pause);

  const sendForce = () =>
    force.mutate(undefined, {
      onSuccess: () => setConfirming(false),
      onError: () => {
        setConfirming(false);
        toast.show(t('pause.toast.forceFailed'), 'error');
      },
    });

  return (
    <div className={styles.progress}>
      <header className={styles.header}>
        {pausing ? (
          <>
            <h3 className={styles.title}>
              {t('pause.progress.pausingTitle', { clock: formatClock(now - Date.parse(pause.requestedAt)) })}
            </h3>
            {countdown !== null ? (
              <p className={styles.meta}>{t('pause.progress.deadline', { clock: formatClock(countdown) })}</p>
            ) : null}
          </>
        ) : (
          <>
            <h3 className={styles.title}>{t('pause.progress.pausedTitle')}</h3>
            {pause.requestedBy ? (
              <p className={styles.meta}>
                {t('pause.progress.requestedBy', {
                  name: pause.requestedBy,
                  time: formatStamp(pause.requestedAt),
                })}
              </p>
            ) : requestedBy ? (
              <p className={styles.meta}>{requestedBy}</p>
            ) : null}
          </>
        )}
      </header>

      {rows.length === 0 ? (
        <p className={styles.empty}>{t('pause.progress.empty')}</p>
      ) : (
        <ul className={styles.rows} aria-label={t('pause.progress.table')}>
          {[...running, ...stopped].map((row) => (
            <Row key={row.sessionId} row={row} now={now} lookups={lookups} />
          ))}
        </ul>
      )}

      {explanations.map((text) => (
        <PauseNote key={text}>{text}</PauseNote>
      ))}

      {canManage && canForceNow(pause, now) ? (
        <footer className={styles.force}>
          <span>{t('pause.force.hint')}</span>
          <Button
            variant="secondary"
            size="md"
            icon="stop"
            loading={force.isPending && !confirming}
            onClick={() => setConfirming(true)}
          >
            {force.isPending && !confirming ? t('pause.force.busy') : t('pause.force.button')}
          </Button>
        </footer>
      ) : null}
      <ForceDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={sendForce}
        busy={force.isPending}
      />
    </div>
  );
}
