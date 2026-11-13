import clsx from 'clsx';
import { useId, useState } from 'react';
import type { BoardCard } from '@projectman/shared';
import { useChangeTaskLabels, useConfig, useLabels } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { TextAreaField, TextField } from '../../components/Field';
import { LabelChip } from '../../components/LabelChip';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import { labelGroups, labelName, viewerLabelRefusal } from '../../lib/labels';
import { isDoneCard, summarizeLabels } from '../../lib/labelSummary';
import type { PipelineIndex } from '../../lib/pipeline';
import styles from './TaskLabels.module.css';
import drawer from './drawer.module.css';

/**
 * The task's labels: chips in their colours (meaning on hover), removable where the label's
 * rules allow, and a picker. A group is one "state" (picking one replaces the others); a label
 * that needs a reason asks for it before it is added. Editing waits for the configuration,
 * which holds the label rules.
 */
export function TaskLabels({ task, pipeline }: { task: BoardCard; pipeline: PipelineIndex }) {
  const { key, myHandle, can } = useProject();
  const foldedId = useId();
  const [expanded, setExpanded] = useState(false);
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
  // A done card folds its process labels (PM-1387); the picker below still offers every applied label.
  const summary = summarizeLabels({
    labels: task.labels,
    definitions: labels,
    stages: pipeline.stages,
    done: isDoneCard(task, pipeline.stages),
  });
  const chip = (id: string, wrap = false) => (
    <li key={id} className={styles.item}>
      <LabelChip id={id} labels={labels} wrap={wrap}>
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
  );

  return (
    <section className={drawer.prop} aria-label={t('task.labels.title')}>
      <h3 className={drawer.propLabel}>{t('task.labels.title')}</h3>
      {task.labels.length > 0 ? (
        <ul className={drawer.propValue}>
          {summary.shown.map((id) => chip(id))}
          {summary.folded.length > 0 ? (
            <li>
              <Button
                size="sm"
                variant="ghost"
                className={styles.fold}
                aria-expanded={expanded}
                aria-controls={foldedId}
                onClick={() => setExpanded(!expanded)}
              >
                {t(expanded ? 'task.labels.foldedHide' : 'task.labels.foldedShow', {
                  count: summary.folded.length,
                })}
              </Button>
            </li>
          ) : null}
        </ul>
      ) : (
        <span className={drawer.propMuted}>{t('task.labels.none')}</span>
      )}
      {editable ? (
        <Button
          size="sm"
          variant="muted"
          iconOnly
          icon="plus"
          aria-label={t('task.labels.add')}
          aria-expanded={picking}
          onClick={() => setPicking(!picking)}
        />
      ) : (
        <span />
      )}

      {summary.folded.length > 0 ? (
        <ul
          id={foldedId}
          className={clsx(drawer.propValue, drawer.propWide, styles.folded)}
          hidden={!expanded}
        >
          {summary.folded.map((id) => chip(id, true))}
        </ul>
      ) : null}

      {editable && picking ? (
        <div className={clsx(styles.picker, drawer.propWide)}>
          <p className={styles.pickerTitle}>{t('task.labels.pickerAll')}</p>
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
          className={clsx(styles.reasonForm, drawer.propWide)}
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
        <p className={clsx(drawer.error, drawer.propWide)} role="alert">
          {errorMessage(change.error)}
        </p>
      ) : null}
    </section>
  );
}
