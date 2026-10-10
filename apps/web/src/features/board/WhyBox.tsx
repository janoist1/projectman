import clsx from 'clsx';
import { useId } from 'react';
import type { InboxItem, LabelView, Task } from '@projectman/shared';
import { useMoveTask, useResolveInbox } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Avatar } from '../../components/Avatar';
import { Button } from '../../components/Button';
import { t } from '../../i18n/t';
import { isApprovalRequested } from '../../lib/errors';
import type { MemberIndex } from '../../lib/members';
import { nameOf } from '../../lib/members';
import type { PipelineIndex } from '../../lib/pipeline';
import type { TaskState } from '../../lib/taskState';
import { moveErrorText } from './moveTask';
import styles from './WhyBox.module.css';

/**
 * "Miért áll?" in the drawer (PM-461): who acts next, what the card waits for, where it would go and what
 * to do, in one `dl`. It carries the viewer's button only where the box is the one place for it: the
 * card mover's "Tovább" of a finished step, and the move of a card a person owns in a queue. Every other
 * item (a question, a permission, a decision, an approval) keeps its own card above or below it.
 */
export function WhyBox({
  task,
  state,
  pipeline,
  members,
  labels,
  inboxItems,
}: {
  task: Task;
  state: TaskState;
  pipeline: PipelineIndex;
  members: MemberIndex;
  labels: readonly LabelView[];
  /** The project's inbox items; the box finds the hand-on item among them. */
  inboxItems: readonly InboxItem[] | undefined;
}) {
  const { key, myHandle } = useProject();
  const resolve = useResolveInbox(key, myHandle);
  const move = useMoveTask(key);
  const titleId = useId();
  const { next, wait } = state;
  if (!next || !wait) return null;

  const stageName = (id: string | null) => (id ? (pipeline.stageById.get(id)?.name ?? id) : '');
  const to = stageName(next.toStageId);
  const here = stageName(task.stageId);

  // The hand-on item is the viewer's own; it stays among the items while its answer is on the way.
  const handOnItem =
    wait.reason === 'hand_on' && next.you && myHandle
      ? (inboxItems?.find((item) => item.id === wait.inboxItemId && item.assignees.includes(myHandle)) ??
        null)
      : null;
  const moveOwn = wait.reason === 'queued' && next.you && next.toStageId !== null;
  const resolving = resolve.isPending && resolve.variables?.item.id === handOnItem?.id;
  const handOnOpen = handOnItem !== null && (handOnItem.state === 'open' || resolving);
  const error = handOnOpen
    ? resolve.isError && resolve.variables?.item.id === handOnItem.id
      ? moveErrorText(resolve.error, labels)
      : null
    : moveOwn && move.isError
      ? moveErrorText(move.error, labels)
      : null;
  const errorIsStatus = moveOwn && move.isError && isApprovalRequested(move.error);
  const busy = resolving || (moveOwn && move.isPending);
  const buttonLabel = busy ? t('task.whyBox.moving') : t('task.whyBox.move', { stage: to });
  const onClick = () => {
    if (handOnOpen && handOnItem) resolve.mutate({ item: handOnItem, body: { optionId: 'move' } });
    else if (moveOwn && next.toStageId) move.mutate({ taskKey: task.key, stageId: next.toStageId });
  };

  return (
    <section
      className={clsx(styles.box, next.you ? styles.needs : next.tone === 'blocked' && styles.blocked)}
      aria-labelledby={titleId}
      data-tone={next.you ? 'needs' : next.tone}
    >
      <h3 id={titleId} className={styles.title}>
        {t('task.whyBox.title')}
      </h3>
      <dl className={styles.rows}>
        <div className={styles.row}>
          <dt>{t('task.whyBox.who')}</dt>
          <dd>
            {next.who.length > 0 ? (
              <ul className={styles.people}>
                {next.who.map((actor) => (
                  <li key={actor.handle} className={styles.person}>
                    <Avatar
                      member={members.get(actor.handle)}
                      handle={actor.handle}
                      isMe={actor.you}
                      size="xs"
                    />
                    <span className={styles.name}>{nameOf(actor.handle, members, myHandle)}</span>
                    <span className={styles.kind}>
                      {actor.kind === 'ai' ? t('task.whyBox.kindAi') : t('task.whyBox.kindHuman')}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              next.noWho
            )}
          </dd>
        </div>
        <div className={styles.row}>
          <dt>{t('task.whyBox.waiting')}</dt>
          <dd>{next.long}</dd>
        </div>
        {to ? (
          <div className={styles.row}>
            <dt>{t('task.whyBox.to')}</dt>
            <dd>{t('task.whyBox.route', { from: here, to })}</dd>
          </div>
        ) : null}
        <div className={styles.row}>
          <dt>{t('task.whyBox.todo')}</dt>
          <dd>{next.todo}</dd>
        </div>
      </dl>
      {handOnOpen || moveOwn ? (
        <div className={styles.actions}>
          <Button size="md" disabled={busy} onClick={onClick}>
            {buttonLabel}
          </Button>
          {error ? (
            <p role={errorIsStatus ? 'status' : 'alert'} className={styles.error}>
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
