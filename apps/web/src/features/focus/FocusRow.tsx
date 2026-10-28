import { useState } from 'react';
import { isOpenTask } from '@projectman/shared';
import type { Task } from '@projectman/shared';
import { Button } from '../../components/Button';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import drawer from '../board/drawer.module.css';
import { useFocus, useFocusPlace } from './FocusContext';
import { FocusMark, focusPlaceText } from './FocusMark';

/**
 * The "Fókusz" row of the open card or theme (PM-438): the place it has and what put it there, and the
 * button that puts it in the focus or takes it off. A viewer who may not change it (a client, say) reads the
 * place only, and has no row for a card outside the focus. A refusal shows under the row, in the drawer's error style.
 */
export function FocusRow({ task }: { task: Task }) {
  const { visible, canEdit, full, items, add, remove } = useFocus();
  const place = useFocusPlace(task.key);
  const [error, setError] = useState<string | null>(null);
  if (!visible) return null;
  const listed = items.some((item) => item.key === task.key);
  const open = isOpenTask(task);
  // Nothing to say and nothing to do: no row.
  if (!place && (!canEdit || !open)) return null;

  const change = (action: () => Promise<void>) => {
    setError(null);
    action().catch((failure: unknown) => setError(errorMessage(failure)));
  };
  const fullTitle = t('errors.codes.focus_full');
  return (
    <>
      <div className={drawer.prop}>
        <span className={drawer.propLabel}>{t('focus.row.label')}</span>
        {place ? (
          <span>
            <FocusMark taskKey={task.key} /> {focusPlaceText(place)}
          </span>
        ) : (
          <span className={drawer.propMuted}>{t('focus.row.none')}</span>
        )}
        {canEdit && listed ? (
          <Button variant="ghost" size="sm" onClick={() => change(() => remove(task.key))}>
            {t('focus.row.remove')}
          </Button>
        ) : null}
        {/* A card that has a place through its theme or parent is not added on its own: "1. hely" would be false. */}
        {canEdit && !listed && !place && open ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={full}
            title={full ? fullTitle : undefined}
            onClick={() => change(() => add(task.key))}
          >
            {t('focus.row.add')}
          </Button>
        ) : null}
      </div>
      {error ? (
        <p className={drawer.error} role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
