import { useState } from 'react';
import type { Task } from '@projectman/shared';
import { useChangeTaskLabels, useConfig, useLabels } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { TextAreaField, TextField } from '../../components/Field';
import { LabelChip } from '../../components/LabelChip';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import { labelGroups, labelName, viewerLabelRefusal } from '../../lib/labels';
import styles from './TaskLabels.module.css';
import drawer from './TaskDrawer.module.css';

/**
 * The task's labels: chips in their colours (meaning on hover), removable where the label's
 * rules allow, and a picker. A group is one "state" (picking one replaces the others); a label
 * that needs a reason asks for it before it is added. Editing waits for the configuration,
 * which holds the label rules.
 */
export function TaskLabels({ task }: { task: Task }) {
  const { key, myHandle, can } = useProject();
  const labels = useLabels(key);
  const config = useConfig(key, can.createTasks).data?.config;
  const change = useChangeTaskLabels(key);
  const [picking, setPicking] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [tag, setTag] = useState('');
  const editable = can.createTasks && Boolean(myHandle) && Boolean(config);
  const refusal = (id: string) =>
    config && myHandle ? viewerLabelRefusal(config, id, myHandle, task) : 'not_holder';
  const submit = (body: { add?: string[]; remove?: string[]; comment?: string }) =>
    change.mutate(
      { taskKey: task.key, body },
      {
        onSuccess: () => {
          setPending(null);
          setComment('');
          setTag('');
        },
      },
    );
  const pick = (id: string) => {
    if (task.labels.includes(id)) return submit({ remove: [id] });
    if (labels.find((label) => label.id === id)?.requiresComment) return setPending(id);
    submit({ add: [id] });
  };
  const pendingLabel = labels.find((label) => label.id === pending);

  return (
    <section className={drawer.section} aria-label={t('task.labels.title')}>
      <div className={styles.head}>
        <h3 className={drawer.sectionTitle}>{t('task.labels.title')}</h3>
        {editable ? (
          <Button size="sm" aria-expanded={picking} onClick={() => setPicking(!picking)}>
            {t('task.labels.add')}
          </Button>
        ) : null}
      </div>
      {task.labels.length > 0 ? (
        <ul className={styles.chips}>
          {task.labels.map((id) => (
            <li key={id}>
              <LabelChip id={id} labels={labels}>
                {editable && !refusal(id) ? (
                  <button
                    type="button"
                    className={styles.remove}
                    aria-label={t('task.labels.remove', { label: labelName(id, labels) })}
                    disabled={change.isPending}
                    onClick={() => submit({ remove: [id] })}
                  >
                    ×
                  </button>
                ) : null}
              </LabelChip>
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.none}>{t('task.labels.none')}</p>
      )}

      {editable && picking ? (
        <div className={styles.picker}>
          {labelGroups(labels).map((group) => (
            <div key={group[0]!.group ?? group[0]!.id} className={styles.group} role="group">
              {group.map((label) => {
                const reason = refusal(label.id);
                const on = task.labels.includes(label.id);
                return (
                  <button
                    key={label.id}
                    type="button"
                    className={styles.option}
                    aria-pressed={on}
                    disabled={Boolean(reason) || change.isPending}
                    title={reason ? t(`task.labels.refusal.${reason}`) : (label.meaning ?? undefined)}
                    onClick={() => pick(label.id)}
                  >
                    <LabelChip id={label.id} labels={labels} />
                    {reason ? (
                      <span className={styles.reason}>{t(`task.labels.refusal.${reason}`)}</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ))}
          <form
            className={styles.tag}
            onSubmit={(event) => {
              event.preventDefault();
              if (tag.trim()) submit({ add: [tag.trim()] });
            }}
          >
            <TextField
              label={t('task.labels.free')}
              hint={t('task.labels.freeHint')}
              value={tag}
              maxLength={40}
              onChange={(event) => setTag(event.target.value)}
            />
            <Button type="submit" size="sm" disabled={!tag.trim() || change.isPending}>
              {t('task.labels.apply')}
            </Button>
          </form>
        </div>
      ) : null}

      {pendingLabel ? (
        <form
          className={styles.reasonForm}
          onSubmit={(event) => {
            event.preventDefault();
            submit({ add: [pendingLabel.id], comment: comment.trim() });
          }}
        >
          <TextAreaField
            label={t('task.labels.comment', { label: pendingLabel.name })}
            hint={t('task.labels.commentHint')}
            value={comment}
            rows={3}
            required
            onChange={(event) => setComment(event.target.value)}
          />
          <div className={styles.actions}>
            <Button type="submit" disabled={!comment.trim()} loading={change.isPending}>
              {t('task.labels.apply')}
            </Button>
            <Button variant="ghost" onClick={() => setPending(null)}>
              {t('common.cancel')}
            </Button>
          </div>
        </form>
      ) : null}
      {change.isError ? (
        <p className={drawer.error} role="alert">
          {errorMessage(change.error)}
        </p>
      ) : null}
    </section>
  );
}
