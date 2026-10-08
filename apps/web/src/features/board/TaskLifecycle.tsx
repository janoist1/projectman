import { useState } from 'react';
import { DEFAULT_AGENT_PROVIDER } from '@projectman/shared';
import type { HandoffStart, Session, Task } from '@projectman/shared';
import { useCancelTask, useReopenTask, useUpdateTask } from '../../api/queries';
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
import { fallbackReasonText, otherProviderSuffix } from '../../lib/handoff';
import type { MemberIndex } from '../../lib/members';
import { nameOf } from '../../lib/members';
import { isTaskClosed } from '../../lib/taskState';
import drawer from './drawer.module.css';
import styles from './TaskLifecycle.module.css';

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
 * The toast of a saved assignee: when the change set off a handoff (PM-342) it says whether the old
 * assignee now hands the work over or the new one starts without it, and why.
 */
export function assigneeSavedText(
  start: HandoffStart | undefined,
  members: MemberIndex,
  myHandle: string | null,
): string {
  if (start?.mode === 'live') return t('handoff.toast.live', { from: nameOf(start.from, members, myHandle) });
  if (start?.mode === 'fallback')
    return t('handoff.toast.fallback', {
      reason: fallbackReasonText(start.reason, start.from, members, myHandle),
    });
  return t('taskLifecycle.assigned');
}

/**
 * The assignee as a select that saves the moment it changes. A live session of the old assignee is
 * no obstacle: the server asks it for a handoff note (PM-342). While the old assignee has a
 * conversation on the card, the members of another provider cannot continue it, and say so.
 */
export function TaskAssigneeSelect({
  task,
  members,
  sessions = [],
}: {
  task: Task;
  members: MemberIndex;
  sessions?: readonly Session[];
}) {
  const { key, myHandle } = useProject();
  const update = useUpdateTask(key);
  const toast = useToast();
  // The select shows the pick while it is saved; otherwise the task's.
  const assignee = update.isPending ? (update.variables?.body.assignee ?? '') : (task.assignee ?? '');
  const current = task.assignee ? members.get(task.assignee) : undefined;
  const hasConversation =
    current?.kind === 'ai' && sessions.some((session) => session.member === task.assignee);
  const currentProvider = current?.provider ?? DEFAULT_AGENT_PROVIDER;
  const save = (next: string) =>
    update.mutate(
      { taskKey: task.key, body: { assignee: next || null } },
      { onSuccess: (saved) => toast.show(assigneeSavedText(saved.handoffStart, members, myHandle)) },
    );
  return (
    <>
      <select
        className={styles.select}
        aria-label={t('taskLifecycle.assignee')}
        value={assignee}
        disabled={update.isPending}
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
              {hasConversation &&
              member.kind === 'ai' &&
              member.handle !== task.assignee &&
              (member.provider ?? DEFAULT_AGENT_PROVIDER) !== currentProvider
                ? otherProviderSuffix()
                : ''}
            </option>
          ))}
      </select>
      {update.isError ? (
        <div className={drawer.propWide}>
          <p role="alert" className={drawer.error}>
            {errorMessage(update.error)}
          </p>
        </div>
      ) : null}
    </>
  );
}
