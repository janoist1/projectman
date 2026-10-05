import { useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  canSetDeveloperLevel,
  DEVELOPER_LEVEL_REASON_MAX,
  developerLevelOf,
  hasActiveSenior,
  isOpenTask,
  isTheme,
} from '@projectman/shared';
import type { DeveloperLevel, Task } from '@projectman/shared';
import { isApiError } from '../../api/client';
import { useConfig, useUpdateTask } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { Chip } from '../../components/Chip';
import { TextAreaField } from '../../components/Field';
import { SegmentedControl } from '../../components/SegmentedControl';
import { useToast } from '../../components/toastContext';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import drawer from './drawer.module.css';
import styles from './TaskLevel.module.css';

const LEVELS: readonly DeveloperLevel[] = ['any', 'senior'];

/**
 * The "Ajánlott" row of a card (PM-349): the developer it is recommended for, with the reason, and a
 * pencil for whoever may change it. A card without a recommendation reads "Bármelyik fejlesztő"; a theme has
 * none, and a closed card is only read.
 */
export function TaskLevel({ task }: { task: Task }) {
  const { key, can, myHandle } = useProject();
  // The right to edit comes from the shared rule over the configuration: without the configuration there is no pencil.
  const config = useConfig(key, can.readConfig).data?.config;
  const editable =
    !!config && myHandle !== null && canSetDeveloperLevel(config, myHandle) && isOpenTask(task);
  const [editing, setEditing] = useState(false);
  const pencil = useRef<HTMLButtonElement>(null);
  if (isTheme(task) || (!task.developerLevel && !editable)) return null;

  const level = developerLevelOf(task);
  const reason = task.developerLevel?.reason?.trim() ?? '';
  // A Senior card of a team without a Senior goes to any developer: the row says so.
  const noSenior = !!config && level === 'senior' && !hasActiveSenior(config, task);
  const close = () => {
    setEditing(false);
    requestAnimationFrame(() => pencil.current?.focus());
  };
  return (
    <div className={drawer.prop}>
      <span className={drawer.propLabel}>{t('task.level.label')}</span>
      {/* While the form is open it takes the place of the reading view: the reason would show twice. */}
      {editing ? (
        <span />
      ) : (
        <span>
          {level === 'senior' ? (
            <Chip tone="accent">{t('task.level.senior')}</Chip>
          ) : (
            <span className={drawer.propMuted}>{t('task.level.any')}</span>
          )}
        </span>
      )}
      {editable && !editing ? (
        <Button
          ref={pencil}
          variant="muted"
          size="sm"
          iconOnly
          icon="pencil"
          aria-label={t('task.level.edit')}
          onClick={() => setEditing(true)}
        />
      ) : (
        <span />
      )}
      {reason && !editing ? <span className={`${drawer.propWide} ${drawer.propMuted}`}>{reason}</span> : null}
      {noSenior && !editing ? (
        <span className={`${drawer.propWide} ${styles.noSenior}`}>{t('task.level.noSenior')}</span>
      ) : null}
      {editing && config ? (
        <LevelEditor task={task} hasSenior={hasActiveSenior(config, task)} onClose={close} onSaved={close} />
      ) : null}
    </div>
  );
}

function LevelEditor({
  task,
  hasSenior,
  onClose,
  onSaved,
}: {
  task: Task;
  hasSenior: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { key } = useProject();
  const update = useUpdateTask(key);
  const toast = useToast();
  const [level, setLevel] = useState<DeveloperLevel>(developerLevelOf(task));
  const [reason, setReason] = useState(task.developerLevel?.reason ?? '');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const missingReason = () => {
    setReasonError(t('task.level.reasonRequired'));
    field.current?.focus();
  };
  const save = () => {
    const text = reason.trim();
    if (level === 'senior' && !text) return missingReason();
    setReasonError(null);
    update.mutate(
      { taskKey: task.key, body: { developerLevel: { level, reason: text || null } } },
      {
        onSuccess: () => {
          toast.show(
            t('task.level.saved', {
              level: level === 'senior' ? t('timeline.levelSenior') : t('timeline.levelAny'),
            }),
          );
          onSaved();
        },
        // The server's own refusal of an empty reason is the field's error too, not a line above the buttons.
        onError: (error) => {
          if (isApiError(error) && error.code === 'developer_level_reason_required') missingReason();
        },
      },
    );
  };
  const refused =
    update.isError && !(isApiError(update.error) && update.error.code === 'developer_level_reason_required');
  return (
    <form
      className={`${drawer.propWide} ${styles.editor}`}
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
      onKeyDown={(event) => {
        // Escape closes the form, not the drawer around it.
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        onClose();
      }}
    >
      <SegmentedControl
        label={t('task.level.choice')}
        className={styles.segments}
        value={level}
        onChange={(next) => {
          setLevel(next);
          setReasonError(null);
        }}
        options={LEVELS.map((value) => ({ value, label: t(`task.level.${value}`) }))}
      />
      <TextAreaField
        ref={field}
        label={level === 'senior' ? t('task.level.reasonSenior') : t('task.level.reasonAny')}
        placeholder={t('task.level.reasonPlaceholder')}
        rows={2}
        maxLength={DEVELOPER_LEVEL_REASON_MAX}
        value={reason}
        error={reasonError}
        onChange={(event) => {
          setReason(event.target.value);
          setReasonError(null);
        }}
        disabled={update.isPending}
      />
      {level === 'senior' && !hasSenior ? (
        <p className={styles.note}>
          {t('task.level.noSeniorEditor')} <Link to={`/p/${key}/team`}>{t('task.level.noSeniorLink')}</Link>
        </p>
      ) : null}
      {task.assignee ? <p className={styles.note}>{t('task.level.keepsAssignee')}</p> : null}
      {refused ? (
        <p role="alert" className={drawer.error}>
          {errorMessage(update.error)}
        </p>
      ) : null}
      <div className={styles.actions}>
        <Button type="submit" variant="primary" size="sm" loading={update.isPending}>
          {update.isPending ? t('task.level.saving') : t('task.level.save')}
        </Button>
        <Button variant="secondary" size="sm" disabled={update.isPending} onClick={onClose}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}
