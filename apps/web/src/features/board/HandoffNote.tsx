import type { Task, TaskHandoffRecord } from '@projectman/shared';
import { useRef, useState } from 'react';
import type { RefObject } from 'react';
import { isApiError } from '../../api/client';
import { useTaskHandoff } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { Chip } from '../../components/Chip';
import { Dialog } from '../../components/Dialog';
import { Fold } from '../../components/Fold';
import { Markdown } from '../../components/Markdown';
import { ErrorState, LoadingState } from '../../components/States';
import { formatAgo } from '../../i18n/format';
import { t } from '../../i18n/t';
import { fallbackReasonText, handoffEndName, handoffPair, providerShift } from '../../lib/handoff';
import type { MemberIndex } from '../../lib/members';
import { shortCommit } from '../../lib/timeline';
import styles from './HandoffNote.module.css';

/**
 * The button of the last closed handoff in the Assignee row (PM-342): "Átadó jegyzet" opens the
 * note in a window; when the receiver started without one, the button is fainter and says so.
 */
export function HandoffNoteButton({ task, members }: { task: Task; members: MemberIndex }) {
  const { key } = useProject();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const last = task.lastHandoff;
  if (!last) return null;
  const fallback = last.outcome === 'fallback';
  return (
    <>
      <Button
        ref={trigger}
        variant="ghost"
        size="sm"
        icon="doc"
        className={fallback ? styles.faint : undefined}
        onClick={() => setOpen(true)}
      >
        {t(fallback ? 'handoff.note.fallbackButton' : 'handoff.note.button')}
      </Button>
      <HandoffNoteDialog
        projectKey={key}
        task={task}
        members={members}
        open={open}
        onClose={() => setOpen(false)}
        returnFocusRef={trigger}
      />
    </>
  );
}

function HandoffNoteDialog({
  projectKey,
  task,
  members,
  open,
  onClose,
  returnFocusRef,
}: {
  projectKey: string;
  task: Task;
  members: MemberIndex;
  open: boolean;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const { myHandle } = useProject();
  const last = task.lastHandoff;
  const record = useTaskHandoff(projectKey, task.key, last?.id ?? null, open);
  if (!last) return null;
  const fallback = last.outcome === 'fallback';
  const data = record.data;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      title={t(fallback ? 'handoff.note.fallbackTitle' : 'handoff.note.title')}
      description={t('handoff.note.description', {
        pair: handoffPair(last, members, myHandle),
        time: formatAgo(last.endedAt),
      })}
      returnFocusRef={returnFocusRef}
    >
      {record.isPending ? (
        <LoadingState compact />
      ) : record.isError ? (
        isApiError(record.error) && record.error.status === 404 ? (
          <ErrorState compact error={record.error} message={t('handoff.note.gone')} />
        ) : (
          <ErrorState
            compact
            error={record.error}
            message={t('handoff.note.loadFailed')}
            onRetry={() => void record.refetch()}
          />
        )
      ) : data ? (
        <HandoffRecordBody record={data} members={members} myHandle={myHandle} />
      ) : null}
    </Dialog>
  );
}

/** The note (or the reason there is none) with the facts about the old worktree. */
export function HandoffRecordBody({
  record,
  members,
  myHandle,
}: {
  record: TaskHandoffRecord;
  members: MemberIndex;
  myHandle: string | null;
}) {
  const shift = providerShift(record.fromProvider, record.toProvider);
  const to = handoffEndName(record.to, members, myHandle);
  if (record.outcome === 'fallback') {
    return (
      <div className={styles.body}>
        {shift ? (
          <div className={styles.chips}>
            <Chip tone="outline">{shift}</Chip>
          </div>
        ) : null}
        <p className={styles.line}>
          {t('handoff.note.fallbackLine', {
            reason: fallbackReasonText(record.fallbackReason, record.from, members, myHandle),
          })}{' '}
          {record.to === null
            ? t('handoff.note.nobody')
            : t(record.summary ? 'handoff.note.withSummary' : 'handoff.note.noSummary', { to })}
        </p>
        {record.summary ? (
          <Fold
            summary={t(
              record.summary.source === 'last_replies' ? 'handoff.note.lastReplies' : 'handoff.note.summary',
            )}
          >
            <pre className={styles.summary}>{record.summary.text}</pre>
          </Fold>
        ) : null}
      </div>
    );
  }
  return (
    <div className={styles.body}>
      <div className={styles.chips}>
        {shift ? <Chip tone="outline">{shift}</Chip> : null}
        {record.lastCommit ? (
          <Chip tone="neutral" mono>
            {t('handoff.note.lastCommit', { commit: shortCommit(record.lastCommit) })}
          </Chip>
        ) : null}
        {record.uncommitted ? <Chip tone="needs">{t('handoff.note.uncommitted')}</Chip> : null}
      </div>
      {record.note?.trim() ? (
        <Markdown text={record.note} />
      ) : (
        <p className={styles.line}>{t('handoff.note.noNote')}</p>
      )}
    </div>
  );
}
