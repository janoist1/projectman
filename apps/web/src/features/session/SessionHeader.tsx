import { useState } from 'react';
import { Link } from 'react-router';
import type { MemberView, Session, Task } from '@projectman/shared';
import { useStopSession } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { Chip, StatusDot } from '../../components/Chip';
import { Dialog } from '../../components/Dialog';
import { Icon } from '../../components/Icon';
import { MoreMenu } from '../../components/MoreMenu';
import { ProviderBadge } from '../../components/ProviderBadge';
import { StageProgress } from '../../components/StageProgress';
import { useToast } from '../../components/toastContext';
import { t } from '../../i18n/t';
import { stagePosition } from '../../lib/pipeline';
import type { PipelineIndex } from '../../lib/pipeline';
import { isLiveSession } from '../../lib/sessions';
import type { SessionStatus } from '../../lib/sessions';
import type { TaskPhase } from '../../lib/taskState';
import { prChip } from '../board/cardModel';
import { shortPath } from './sessionModel';
import styles from './SessionHeader.module.css';

/**
 * The session's crumbs, live status and stop, its title, and chips for stage, PR, branch, the
 * agent CLI the session runs (the member's for sessions from before it was recorded) and model.
 */
export function SessionHeader({
  session,
  task,
  title,
  memberName,
  member,
  pipeline,
  taskPhase,
  live,
}: {
  session: Session;
  task: Task | null;
  title: string;
  memberName: string;
  member: MemberView | undefined;
  pipeline: PipelineIndex | null;
  taskPhase: TaskPhase | null;
  live: { status: SessionStatus; label: string };
}) {
  const { key } = useProject();
  const stop = useStopSession(key);
  const toast = useToast();
  const [confirmStop, setConfirmStop] = useState(false);
  const stage = task && pipeline ? pipeline.stageById.get(task.stageId) : undefined;
  const column = task && pipeline ? pipeline.columnOfStage.get(task.stageId) : undefined;
  const pr = task ? prChip(task) : null;
  return (
    <div className={styles.header}>
      <div className={styles.crumbRow}>
        <nav aria-label={t('session.breadcrumb')} className={styles.crumbs}>
          <Link to={`/p/${key}`} className={styles.crumbLink}>
            {t('nav.board')}
          </Link>
          <Icon name="chevronRight" size={14} strokeWidth={2} />
          {task ? (
            <Link to={`/p/${key}/tasks/${task.key}`} className={styles.crumbLink}>
              {column?.name ?? task.key}
            </Link>
          ) : (
            <span>{memberName}</span>
          )}
        </nav>
        <span className={styles.spacer} />
        <span className={styles.live} data-status={live.status} role="status">
          <StatusDot status={live.status} pulse={live.status === 'working'} size={9} />
          <span>{live.label}</span>
        </span>
        {isLiveSession(session) ? (
          <MoreMenu>
            {(close) => (
              <Button
                variant="danger"
                icon="stop"
                onClick={() => {
                  setConfirmStop(true);
                  close();
                }}
              >
                {t('session.stop')}
              </Button>
            )}
          </MoreMenu>
        ) : null}
      </div>
      <h1 className={styles.title}>{title}</h1>
      <div className={styles.chips}>
        {task && pipeline && taskPhase ? (
          <span className={styles.stageChip}>
            <StageProgress pipeline={pipeline} stageId={task.stageId} phase={taskPhase} variant="chip" />
            <span>
              {t('task.stageChip', {
                stage: stage?.name ?? task.stageId,
                index: stagePosition(pipeline, task.stageId).index,
                total: stagePosition(pipeline, task.stageId).total,
              })}
            </span>
          </span>
        ) : null}
        {pr ? (
          <Chip tone="outline" size="md" icon={pr.merged ? 'prMerged' : 'prOpen'} className={styles.prChip}>
            {pr.label}
          </Chip>
        ) : null}
        {session.branch ? (
          <Chip tone="outline" size="md" mono title={t('session.chips.branch', { branch: session.branch })}>
            {session.branch}
          </Chip>
        ) : null}
        <Chip tone="outline" size="md" mono title={t('session.chips.cwd', { cwd: session.cwd })}>
          {shortPath(session.cwd)}
        </Chip>
        <ProviderBadge provider={session.provider ?? member?.provider} />
        {member?.model ? <Chip size="md">{t('session.chips.model', { model: member.model })}</Chip> : null}
        {member?.permissionMode ? (
          <Chip size="md">
            {t('session.chips.permissions', { mode: t(`permissionModes.${member.permissionMode}`) })}
          </Chip>
        ) : null}
      </div>
      <Dialog
        open={confirmStop}
        onClose={() => setConfirmStop(false)}
        title={t('session.stopTitle')}
        description={t('session.stopBody')}
        size="sm"
        footer={
          <>
            <Button
              variant="dangerSolid"
              icon="stop"
              loading={stop.isPending}
              onClick={() =>
                stop.mutate(session.id, {
                  onSuccess: () => {
                    toast.show(t('session.stopped'));
                    setConfirmStop(false);
                  },
                  onError: () => toast.show(t('errors.generic'), 'error'),
                })
              }
            >
              {t('session.stop')}
            </Button>
            <Button variant="secondary" onClick={() => setConfirmStop(false)}>
              {t('common.cancel')}
            </Button>
          </>
        }
      />
    </div>
  );
}
