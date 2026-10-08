import clsx from 'clsx';
import { useRef, useState } from 'react';
import { Link } from 'react-router';
import type { Task, TaskRelation } from '@projectman/shared';
import { useUpdateTask } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { Chip, StatusDot } from '../../components/Chip';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/toastContext';
import { t } from '../../i18n/t';
import type { PipelineIndex } from '../../lib/pipeline';
import { isTaskClosed } from '../../lib/taskState';
import type { TaskPhase } from '../../lib/taskState';
import { useCardLink } from './cardSize';
import { useDrawerBase } from './drawerBase';
import { groupProgress, relationGroups, removeConsequence } from './relationModel';
import { RelationDialog } from './RelationDialog';
import drawer from './drawer.module.css';
import styles from './TaskRelations.module.css';

/** A group with more rows than this shows the first `SHOWN` and a button for the rest. */
const COLLAPSE_OVER = 6;
const SHOWN = 5;

function RelationRow({
  relation,
  task,
  tasks,
  phase,
  pipeline,
  editable,
  onRemoved,
}: {
  relation: TaskRelation;
  task: Task;
  tasks: readonly Task[];
  phase: TaskPhase;
  pipeline: PipelineIndex;
  editable: boolean;
  /** The row is gone: the focus it held goes elsewhere. */
  onRemoved: () => void;
}) {
  const { key } = useProject();
  const cardLink = useCardLink();
  const drawerBase = useDrawerBase();
  const update = useUpdateTask(key);
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const removeRef = useRef<HTMLButtonElement>(null);
  const kind = t(`relations.kinds.${relation.kind}`);
  const closed = isTaskClosed(relation);
  const column = pipeline.columnOfStage.get(relation.stageId);
  const consequence = confirming ? removeConsequence(relation, task, tasks) : null;
  const stop = () => {
    setConfirming(false);
    update.reset();
    removeRef.current?.focus();
  };
  const remove = () =>
    update.mutate(
      { taskKey: task.key, body: { relations: { remove: [{ kind: relation.kind, key: relation.key }] } } },
      {
        onSuccess: () => {
          setConfirming(false);
          toast.show(t('timeline.relationRemoved', { kind, ref: relation.key }));
          onRemoved();
        },
      },
    );
  return (
    <li className={styles.item} data-pending={update.isPending || undefined}>
      <div className={styles.row}>
        <Link to={cardLink(drawerBase.card(relation.key))} className={styles.link}>
          <StatusDot phase={phase} pulse={phase === 'working'} />
          <span className={styles.key}>{relation.key}</span>
          <span className={styles.title}>{relation.title}</span>
          <Chip
            tone={closed ? (relation.status === 'done' ? 'ok' : 'neutral') : 'column'}
            data-column-color={closed ? undefined : column?.color}
          >
            {closed
              ? t(`taskStatus.statuses.${relation.status}`)
              : (pipeline.stageById.get(relation.stageId)?.name ?? relation.stageId)}
          </Chip>
        </Link>
        {editable ? (
          <button
            ref={removeRef}
            type="button"
            className={styles.remove}
            aria-label={t('task.relations.remove', { kind, key: relation.key })}
            aria-expanded={confirming}
            disabled={update.isPending}
            onClick={() => setConfirming(true)}
          >
            <Icon name="close" size={14} strokeWidth={2.2} />
          </button>
        ) : null}
      </div>
      {confirming ? (
        <div
          className={styles.confirm}
          role="group"
          aria-label={t('task.relations.remove', { kind, key: relation.key })}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.stopPropagation();
            stop();
          }}
        >
          <p>{t('task.relations.removeConfirm')}</p>
          {consequence ? <p>{consequence}</p> : null}
          {update.isError ? (
            <p className={drawer.error} role="alert">
              {t('task.relations.removeFailed')}
            </p>
          ) : null}
          <div className={styles.confirmActions}>
            <Button size="sm" variant="secondary" onClick={stop}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" variant="danger" autoFocus loading={update.isPending} onClick={remove}>
              {update.isError ? t('task.relations.retry') : t('task.relations.removeAction')}
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

/**
 * The drawer's "Kapcsolatok" section (PM-203): the card's relations by kind, from both of its sides
 * (the shared `taskRelations` over the board's cards, closed ones included), each a link to the
 * other card with a cross to delete it, and a "+" that opens the dialog to add one. A card the
 * viewer may not see is not on the board, so it is not here.
 */
export function TaskRelations({
  task,
  tasks,
  phases,
  pipeline,
}: {
  task: Task;
  tasks: readonly Task[];
  phases: ReadonlyMap<string, TaskPhase>;
  pipeline: PipelineIndex;
}) {
  const { can } = useProject();
  const [adding, setAdding] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const groups = relationGroups(task, tasks);
  const count = groups.reduce((sum, group) => sum + group.relations.length, 0);
  return (
    <section className={drawer.prop} aria-label={t('task.relations.title')}>
      <h3 className={drawer.propLabel}>{t('task.relations.title')}</h3>
      <span className={clsx(count === 0 && drawer.propMuted)}>
        {count > 0 ? t('task.relations.count', { count }) : t('task.relations.none')}
      </span>
      {can.createTasks ? (
        <Button
          ref={addRef}
          size="sm"
          variant="muted"
          iconOnly
          icon="plus"
          aria-label={t('task.relations.add')}
          aria-haspopup="dialog"
          onClick={() => setAdding(true)}
        />
      ) : (
        <span />
      )}
      {groups.map((group) => {
        const name = t(`relations.kinds.${group.kind}`);
        const progress = groupProgress(group);
        const collapsed = group.relations.length > COLLAPSE_OVER && !expanded.has(group.kind);
        const shown = collapsed ? group.relations.slice(0, SHOWN) : group.relations;
        return (
          <div
            key={group.kind}
            role="group"
            aria-label={name}
            className={clsx(styles.group, drawer.propWide)}
          >
            <h4 className={styles.groupHead}>
              {name}
              {progress ? (
                <span className={styles.progress}>{t('task.relations.progress', progress)}</span>
              ) : null}
            </h4>
            <ul className={styles.list}>
              {shown.map((relation) => (
                <RelationRow
                  key={`${relation.kind}:${relation.key}`}
                  relation={relation}
                  task={task}
                  tasks={tasks}
                  phase={phases.get(relation.key) ?? 'waiting'}
                  pipeline={pipeline}
                  editable={can.createTasks}
                  onRemoved={() => addRef.current?.focus()}
                />
              ))}
            </ul>
            {collapsed ? (
              <Button
                size="sm"
                variant="muted"
                onClick={() => setExpanded(new Set([...expanded, group.kind]))}
              >
                {t('task.relations.showAll', { count: group.relations.length })}
              </Button>
            ) : null}
          </div>
        );
      })}
      <RelationDialog
        open={adding}
        onClose={() => setAdding(false)}
        task={task}
        tasks={tasks}
        pipeline={pipeline}
      />
    </section>
  );
}
