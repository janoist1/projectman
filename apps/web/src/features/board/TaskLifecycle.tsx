import { useEffect, useState } from 'react';
import type { Task } from '@projectman/shared';
import { isApiError } from '../../api/client';
import { useCancelTask, useReopenTask, useStopSession, useUpdateTask } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { SelectField, TextAreaField } from '../../components/Field';
import { useToast } from '../../components/toastContext';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import type { MemberIndex } from '../../lib/members';
import { nameOf } from '../../lib/members';
import { isTaskClosed } from '../../lib/taskState';
import styles from './TaskDrawer.module.css';
import formStyles from '../team/HireDialog.module.css';

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

export function TaskLifecycle({ task, members }: { task: Task; members: MemberIndex }) {
  const { key, myHandle } = useProject();
  const cancel = useCancelTask(key);
  const reopen = useReopenTask(key);
  const update = useUpdateTask(key);
  const stop = useStopSession(key);
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [reason, setReason] = useState('');
  const [assignee, setAssignee] = useState(task.assignee ?? '');
  useEffect(() => setAssignee(task.assignee ?? ''), [task.assignee]);
  const sessionId = liveSessionId(update.error);
  const open = !isTaskClosed(task);
  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>{t('taskLifecycle.title')}</h3>
      <div className={formStyles.form}>
        <SelectField
          label={t('taskLifecycle.assignee')}
          value={assignee}
          onChange={(event) => {
            setAssignee(event.target.value);
            update.reset();
          }}
        >
          <option value="">{t('taskLifecycle.nobody')}</option>
          {[...members.values()]
            .filter((member) => member.status !== 'retired')
            .map((member) => (
              <option key={member.handle} value={member.handle}>
                {nameOf(member.handle, members, myHandle)}
              </option>
            ))}
        </SelectField>
        <Button
          variant="secondary"
          loading={update.isPending}
          onClick={() =>
            update.mutate(
              { taskKey: task.key, body: { assignee: assignee || null } },
              { onSuccess: () => toast.show(t('taskLifecycle.assigned')) },
            )
          }
        >
          {t('taskLifecycle.assign')}
        </Button>
        {update.isError ? (
          <p role="alert" className={styles.error}>
            {errorMessage(update.error)}
          </p>
        ) : null}
        {sessionId ? (
          <Button
            variant="danger"
            loading={stop.isPending}
            onClick={() =>
              stop.mutate(sessionId, {
                onSuccess: () => {
                  update.reset();
                  toast.show(t('taskLifecycle.stopped'));
                },
              })
            }
          >
            {t('taskLifecycle.stop')}
          </Button>
        ) : null}
        {stop.isError ? (
          <p role="alert" className={styles.error}>
            {errorMessage(stop.error)}
          </p>
        ) : null}
        {open ? (
          <Button
            variant="danger"
            onClick={() => {
              cancel.reset();
              setReason('');
              setConfirm(true);
            }}
          >
            {t('taskLifecycle.cancel')}
          </Button>
        ) : null}
        {task.status === 'cancelled' ? (
          <Button
            variant="primary"
            loading={reopen.isPending}
            onClick={() =>
              reopen.mutate(task.key, {
                onSuccess: () => {
                  setAssignee('');
                  toast.show(t('taskLifecycle.reopened'));
                },
              })
            }
          >
            {t('taskLifecycle.reopen')}
          </Button>
        ) : null}
        {reopen.isError ? (
          <p role="alert" className={styles.error}>
            {errorMessage(reopen.error)}
          </p>
        ) : null}
      </div>
      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title={t('taskLifecycle.confirm')}
        description={t('taskLifecycle.warning')}
      >
        <div className={formStyles.form}>
          <TextAreaField
            label={t('taskLifecycle.reason')}
            optional
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          {cancel.isError ? (
            <p role="alert" className={styles.error}>
              {errorMessage(cancel.error)}
            </p>
          ) : null}
          <div className={formStyles.actions}>
            <Button
              variant="dangerSolid"
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
            <Button variant="secondary" onClick={() => setConfirm(false)}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      </Dialog>
    </section>
  );
}
