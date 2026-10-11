import { mergeRequestOf, alertPayloadOf } from '@projectman/shared';
import type { InboxItem, ResolveInboxRequest } from '@projectman/shared';
import { useBoard, useConfig, useStartMerge } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button, ButtonLink } from '../../components/Button';
import { Fold } from '../../components/Fold';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import {
  mergeBlockText,
  mergeCommitOf,
  mergeOnGithub,
  mergeRepo,
  mergeRequestedText,
  mergeTargetName,
} from '../../lib/merge';
import { shortCommit } from '../../lib/timeline';
import styles from './InboxCard.module.css';
import mergeStyles from './MergeInbox.module.css';

/** The card a merge item is about, and the configuration for the words of its repository. */
function useMergeFacts(taskKey: string | undefined) {
  const { key, can } = useProject();
  const board = useBoard(key);
  const config = useConfig(key, can.readConfig).data?.config;
  const task = taskKey ? board.data?.tasks.find((entry) => entry.key === taskKey) : undefined;
  return { task, config };
}

/**
 * What a merge item tells under its heading (PM-453): what merging does, or why the last try failed or
 * stopped, in the same words as the card's merge box.
 */
export function MergeInboxBody({ item }: { item: InboxItem }) {
  const request = mergeRequestOf(item);
  const alert = item.kind === 'alert' ? alertPayloadOf(item) : null;
  const blocked = alert?.alert === 'merge_blocked' ? alert : null;
  const { task, config } = useMergeFacts(request?.taskKey ?? blocked?.taskKey);
  if (request) {
    const repo = mergeRepo(config, request.repo);
    const check = task?.merge?.check?.command ?? repo?.reviewTest?.command ?? null;
    const failure = request.failure;
    if (task?.merge?.state === 'fixing')
      return <p className={styles.body}>{t('task.merge.fixing.you', { base: request.base })}</p>;
    if (!failure) {
      const commit = task ? mergeCommitOf(task) : null;
      return (
        <p className={styles.body}>
          {mergeRequestedText({
            commit: commit ? shortCommit(commit) : null,
            base: request.base,
            check,
            push: !!repo?.github,
          })}
        </p>
      );
    }
    const conflict = failure.reason !== 'check_failed';
    const files = failure.files ?? [];
    const tail = failure.outputTail;
    return (
      <>
        <p className={styles.body}>{t('task.merge.failed.unchanged', { base: request.base })}</p>
        {conflict && files.length > 0 ? (
          <Fold summary={t('task.merge.failed.files', { count: files.length })}>
            <pre className={mergeStyles.output}>{files.join('\n')}</pre>
          </Fold>
        ) : null}
        {!conflict && tail ? (
          <Fold summary={t('task.merge.failed.output')}>
            <pre className={mergeStyles.output}>{tail}</pre>
          </Fold>
        ) : null}
        <p className={styles.body}>{t('task.merge.failed.guidance')}</p>
      </>
    );
  }
  if (!blocked) return null;
  const merge = task?.merge;
  const base = merge?.base ?? config?.project?.repos[0]?.defaultBranch ?? '';
  const repoName = merge?.repo ?? config?.project?.repos[0]?.name ?? '';
  const sentence = mergeBlockText(
    {
      repo: repoName,
      base,
      landed: merge?.landed ?? 'nowhere',
      toStageId: merge?.toStageId ?? '',
      check: merge?.check,
      block: { reason: blocked.reason, message: blocked.message, at: item.createdAt },
    },
    {
      github: mergeOnGithub(config, repoName),
      check: merge?.check?.command ?? mergeRepo(config, repoName)?.reviewTest?.command ?? null,
      target: merge ? mergeTargetName(config, merge) : t('timeline.events.merge_target_unknown'),
    },
  );
  return (
    <>
      <p className={styles.body}>{sentence}</p>
      <p className={styles.body}>
        {merge?.landed === 'remote'
          ? t(
              mergeOnGithub(config, repoName)
                ? 'task.merge.blocked.remote'
                : 'task.merge.blocked.remoteOther',
            )
          : t('task.merge.blocked.nowhere', { base })}
      </p>
      {blocked.message ? (
        <Fold summary={t('task.merge.details')}>
          <pre className={mergeStyles.output}>{blocked.message}</pre>
        </Fold>
      ) : null}
    </>
  );
}

/**
 * The buttons of a merge item: "Beolvasztás" (it resolves the request with the option `merge`), or for the
 * blocked alert "Újrapróbálás" (the same call as the card's, not a resolve), and the way to the card.
 */
export function MergeInboxActions({
  item,
  size,
  pending,
  detailsHref,
  onResolve,
}: {
  item: InboxItem;
  size: 'lg' | 'xl';
  pending: boolean;
  detailsHref?: string | null;
  onResolve: (item: InboxItem, body: ResolveInboxRequest) => void;
}) {
  const { key } = useProject();
  const start = useStartMerge(key);
  const request = mergeRequestOf(item);
  const alert = item.kind === 'alert' ? alertPayloadOf(item) : null;
  const blocked = alert?.alert === 'merge_blocked' ? alert : null;
  const again = !!request?.failure;
  // The merger fixes the conflict in its own checkout (PM-471): merging again is not offered until it submits the fix.
  const { task } = useMergeFacts(request?.taskKey);
  const fixing = task?.merge?.state === 'fixing';
  return (
    <>
      <div className={mergeStyles.actions}>
        {request && fixing ? null : request ? (
          <Button
            variant="primary"
            size={size}
            disabled={pending}
            onClick={() => onResolve(item, { optionId: 'merge' })}
          >
            {t(again ? 'task.merge.again' : 'task.merge.button')}
          </Button>
        ) : blocked ? (
          <Button
            variant="primary"
            size={size}
            loading={start.isPending}
            onClick={() => start.mutate(blocked.taskKey)}
          >
            {start.isPending ? t('task.merge.retrying') : t('task.merge.retry')}
          </Button>
        ) : null}
        {detailsHref ? (
          <ButtonLink to={detailsHref} variant="secondary" size={size}>
            {t('inbox.mergeRequest.open')}
          </ButtonLink>
        ) : null}
      </div>
      {start.isError ? (
        <p className={styles.error} role="alert">
          {errorMessage(start.error)}
        </p>
      ) : null}
    </>
  );
}
