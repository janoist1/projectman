import type { Task } from '@projectman/shared';
import { useStartMerge } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import { mergeRefusal } from '../../lib/merge';
import type { RefusalFacts } from '../../lib/merge';
import styles from './drawer.module.css';

/**
 * The refusal of a move into a step that wants the approved work merged first (`task_not_merged`, PM-453):
 * the same sentence wherever a move is refused. Whoever can only wait gets an information bar; the merger
 * gets the error and a Beolvasztás button that starts the merge right there. Null for any other error.
 */
export function MergeRefusal({
  error,
  task,
  facts,
  onStarted,
}: {
  error: unknown;
  task: Task;
  facts: RefusalFacts;
  /** The merge was started: the caller may close its panel and forget the refused move. */
  onStarted?: () => void;
}) {
  const { key } = useProject();
  const start = useStartMerge(key);
  const refusal = mergeRefusal(error, facts);
  if (!refusal) return null;
  return (
    <>
      <p
        role={refusal.tone === 'info' ? 'status' : 'alert'}
        className={refusal.tone === 'info' ? styles.info : styles.error}
      >
        {refusal.text}
      </p>
      {refusal.mayMerge ? (
        <>
          {start.isError ? (
            <p role="alert" className={styles.error}>
              {errorMessage(start.error)}
            </p>
          ) : null}
          <Button
            size="md"
            loading={start.isPending}
            onClick={() => start.mutate(task.key, { onSuccess: () => onStarted?.() })}
          >
            {start.isPending ? t('task.merge.starting') : t('task.merge.button')}
          </Button>
        </>
      ) : null}
    </>
  );
}
