import { useState } from 'react';
import type { Task } from '@projectman/shared';
import { isApiError } from '../../api/client';
import { useCancelTask, useReopenTask, useStopSession, useUpdateTask } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { ErrorBanner } from '../../components/ErrorBanner';
import { TextAreaField } from '../../components/Field';
import { leaveSuffix } from '../../components/LeaveChip';
import { MoreMenu } from '../../components/MoreMenu';
import { useToast } from '../../components/toastContext';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import type { MemberIndex } from '../../lib/members';
import { nameOf } from '../../lib/members';
import { isTaskClosed } from '../../lib/taskState';
import drawer from './drawer.module.css';
import styles from './TaskLifecycle.module.css';

function liveSessionId(error: unknown): string | null {
  if (
    !isApiError(error) ||
    error.code !== 'task_session_live' ||
    !error.details ||
    typeof error.details !== 'object'
  )
    return null;
  const id = (error.details as { sessionId?: unknown }).sessionId;
  return typeof id === 'string' ? id : null;
}

/**
 * The "⋯" menu of the rare task actions: cancelling the task (after a confirmation with an
 * optional reason) and reopening a cancelled one. Nothing to offer on a finished task.
 */
export function TaskLifecycleMenu({ task }: { task: Task }) {
  const { key } = useProject();
  const cancel = useCancelTask(key);
  const reopen = useReopenTask(key);
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [reason, setReason] = useState('');
  const open = !isTaskClosed(task);
  const cancelled = task.status === 'cancelled';
  if (!open && !cancelled) return null;
  return (
    <>
      <MoreMenu label={t('taskLifecycle.title')}>
        {(close) => (
          <>
            {open ? (
              <Button
                variant="danger"
                onClick={() => {
                  cancel.reset();
                  setReason('');
                  setConfirm(true);
                  close();
                }}
              >
                {t('taskLifecycle.cancel')}
              </Button>
            ) : null}
            {cancelled ? (
              <Button
                variant="primary"
                loading={reopen.isPending}
                onClick={() =>
                  reopen.mutate(task.key, {
                    onSuccess: () => {
                      toast.show(t('taskLifecycle.reopened'));
                      close();
                    },
                  })
                }
              >
                {t('taskLifecycle.reopen')}
              </Button>
            ) : null}
            {reopen.isError ? (
              <p role="alert" className={drawer.error}>
                {errorMessage(reopen.error)}
              </p>
            ) : null}
          </>
        )}
      </MoreMenu>
      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title={t('taskLifecycle.confirm')}
        description={t('taskLifecycle.warning')}
        size="sm"
        error={cancel.isError ? <ErrorBanner>{errorMessage(cancel.error)}</ErrorBanner> : null}
        footer={
          <>
            <Button variant="secondary" size="md" onClick={() => setConfirm(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="dangerSolid"
              size="md"
              loading={cancel.isPending}
              onClick={() =>
                cancel.mutate(
                  { taskKey: task.key, body: reason.trim() ? { reason: reason.trim() } : {} },
                  {
                    onSuccess: () => {
                      setConfirm(false);
                      toast.show(t('taskLifecycle.cancelled'));
                    },
                  },
                )
              }
            >
              {t('taskLifecycle.cancel')}
            </Button>
          </>
        }
      >
        <TextAreaField
          label={t('taskLifecycle.reason')}
          optional
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </Dialog>
    </>
  );
}

/**
 * The assignee as a select that saves the moment it changes. A task with a live session refuses
 * the change; the refusal offers stopping that session, which then saves the pick.
 */
export function TaskAssigneeSelect({ task, members }: { task: Task; members: MemberIndex }) {
  const { key, myHandle } = useProject();
  const update = useUpdateTask(key);
  const stop = useStopSession(key);
  const toast = useToast();
  const sessionId = liveSessionId(update.error);
  // The select shows the pick while it is saved, or held back by a live session; otherwise the task's.
  const showsPick = update.isPending || Boolean(sessionId);
  const assignee = showsPick ? (update.variables?.body.assignee ?? '') : (task.assignee ?? '');
  const save = (next: string) =>
    update.mutate(
      { taskKey: task.key, body: { assignee: next || null } },
      { onSuccess: () => toast.show(t('taskLifecycle.assigned')) },
    );
  return (
    <>
      <select
        className={styles.select}
        aria-label={t('taskLifecycle.assignee')}
        value={assignee}
        disabled={update.isPending || stop.isPending}
        onChange={(event) => save(event.target.value)}
      >
        <option value="">{t('taskLifecycle.nobody')}</option>
        {[...members.values()]
          .filter((member) => member.status !== 'retired' || member.handle === task.assignee)
          .map((member) => (
            <option
              key={member.handle}
              value={member.handle}
              disabled={member.onLeave === true && member.handle !== task.assignee}
            >
              {nameOf(member.handle, members, myHandle)}
              {leaveSuffix(member)}
            </option>
          ))}
      </select>
      {update.isError || stop.isError ? (
        <div className={drawer.propWide}>
          <p role="alert" className={drawer.error}>
            {errorMessage(stop.isError ? stop.error : update.error)}
          </p>
          {sessionId ? (
            <Button
              variant="danger"
              size="sm"
              loading={stop.isPending}
              onClick={() =>
                stop.mutate(
                  { sessionId, purpose: 'assignee_change' },
                  {
                    onSuccess: () => {
                      toast.show(t('taskLifecycle.stopped'));
                      save(assignee);
                    },
                  },
                )
              }
            >
              {t('taskLifecycle.stop')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
