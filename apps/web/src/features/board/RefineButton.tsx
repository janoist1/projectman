import { REFINE_LABEL } from '@projectman/shared';
import type { Task } from '@projectman/shared';
import { useChangeTaskLabels } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { useToast } from '../../components/toastContext';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import drawer from './drawer.module.css';

/**
 * The "Kidolgozás" button: puts the `refine` label on the card, which starts its refinement (the
 * same as a person setting the label). Whether it is offered is `canStartRefinement`'s rule; it is the
 * main action (`primary`) when working the card out is the next step (PM-291).
 */
export function RefineButton({ task, primary = false }: { task: Task; primary?: boolean }) {
  const { key } = useProject();
  const change = useChangeTaskLabels(key);
  const toast = useToast();
  return (
    <>
      <Button
        variant={primary ? 'primary' : 'secondary'}
        size="md"
        icon="sparkle"
        loading={change.isPending}
        onClick={() =>
          change.mutate(
            { taskKey: task.key, body: { add: [REFINE_LABEL] } },
            { onSuccess: () => toast.show(t('task.refine.started', { key: task.key })) },
          )
        }
      >
        {change.isPending ? t('task.refine.starting') : t('task.refine.button')}
      </Button>
      {change.isError ? (
        <p className={drawer.error} role="alert">
          {errorMessage(change.error)}
        </p>
      ) : null}
    </>
  );
}
