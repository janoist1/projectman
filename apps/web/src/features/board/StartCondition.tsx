import { createContext, useContext, useRef } from 'react';
import { Link } from 'react-router';
import {
  effectivePriority,
  isOpenTask,
  startConditionHeld,
  startConditionHolds,
  startConditionImmediate,
  startConditionTracked,
  TASK_PRIORITIES,
} from '@projectman/shared';
import type { BoardCard, ProjectConfig, StartConditionMarksResponse, TaskPriority } from '@projectman/shared';
import { useUpdateTask } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { t } from '../../i18n/t';
import styles from './StartCondition.module.css';

interface StartConditionData {
  config: ProjectConfig;
  tasks: readonly BoardCard[];
  marks: StartConditionMarksResponse['marks'];
}
export const StartConditionContext = createContext<StartConditionData | null>(null);
export const useStartCondition = () => useContext(StartConditionContext);
export type StartFilter = 'all' | 'go' | 'ideas' | 'held';

export function startFlags(task: BoardCard, data: StartConditionData) {
  const { config, tasks } = data;
  const tracked = startConditionTracked(task, config);
  const held =
    isOpenTask(task) && task.kind !== 'theme' && !task.archivedAt && startConditionHeld(task, tasks, config);
  const go = startConditionHolds(task, tasks, config);
  // A held card can also be an idea: remove only the hold to evaluate its configured trigger.
  const unheld = held
    ? { ...config, team: { ...config.team, startCondition: { ...config.team.startCondition!, hold: [] } } }
    : config;
  const ideas = tracked && !startConditionHolds(task, tasks, unheld);
  return { go, ideas, held };
}

export function startMatches(task: BoardCard, data: StartConditionData | null, filter: StartFilter) {
  return !data || filter === 'all' || startFlags(task, data)[filter];
}

/** Names and source links are presentation; all effective values come from shared rules. */
export function PrioritySources({ task, data }: { task: BoardCard; data: StartConditionData }) {
  const { key } = useProject();
  const effective = effectivePriority(task, data.tasks);
  const parent = data.tasks.find((card) => card.key === task.parentKey);
  const theme = data.tasks.find((card) => card.key === (task.themeKey ?? parent?.themeKey));
  const sources = [parent, theme].filter(
    (card): card is BoardCard => !!card && isOpenTask(card) && !card.archivedAt,
  );
  const inherited = sources.filter((card) => card.priority && card.priority === effective);
  const condition = data.config.team.startCondition!;
  const labelNames = (ids: readonly string[]) =>
    ids.map((id) => data.config.pipeline.labels.find((label) => label.id === id)?.name ?? id).join(', ');
  return (
    <div className={styles.details}>
      <p>
        {t('priority.effective', {
          level: effective ? t(`priority.levels.${effective}`) : t('priority.none'),
        })}
        {inherited.length ? ` · ${t('priority.inherited')}` : ''}
      </p>
      {inherited.map((card) => (
        <Link key={card.key} to={`/p/${key}/tasks/${card.key}`}>
          {t(card.kind === 'theme' ? 'priority.themeSource' : 'priority.parentSource', {
            key: card.key,
            title: card.title,
          })}
        </Link>
      ))}
      {condition.labels
        ? [task, ...sources].map((card) => {
            const labels = card.labels.filter((id) => condition.labels!.includes(id));
            return labels.length ? (
              <p key={card.key}>
                {t('board.start.labelSource', { labels: labelNames(labels) })} ·{' '}
                <Link to={`/p/${key}/tasks/${card.key}`}>
                  {card.key} · {card.title}
                </Link>
              </p>
            ) : null;
          })
        : null}
    </div>
  );
}

export function CardStartDetails({ task }: { task: BoardCard }) {
  const data = useStartCondition();
  if (!data) return null;
  const flags = startFlags(task, data);
  const mark = data.marks.find((mark) => mark.taskKey === task.key);
  const grace =
    flags.go &&
    mark &&
    Date.parse(mark.dueAt) > Date.now() &&
    !startConditionImmediate(task, data.tasks, data.config);
  return (
    <div className={styles.details}>
      {grace ? <p>{t('board.start.gracePending')}</p> : null}
      <PrioritySources task={task} data={data} />
      <QuickPriority task={task} />
    </div>
  );
}

export function StartBadge({ task }: { task: BoardCard }) {
  const data = useStartCondition();
  if (!data) return null;
  const flags = startFlags(task, data);
  const parent = data.tasks.find((card) => card.key === task.parentKey);
  const theme = data.tasks.find((card) => card.key === (task.themeKey ?? parent?.themeKey));
  const holds = [task, parent, theme]
    .filter((card): card is BoardCard => !!card && isOpenTask(card) && !card.archivedAt)
    .flatMap((card) => card.labels)
    .filter((id) => data.config.team.startCondition!.hold.includes(id));
  const heldNames = [...new Set(holds)]
    .map((id) => data.config.pipeline.labels.find((label) => label.id === id)?.name ?? id)
    .join(', ');
  return flags.held ? (
    <span className={`${styles.mark} ${styles.held}`}>Ⅱ {heldNames}</span>
  ) : flags.go ? (
    <span className={styles.mark}>→ {t('board.start.go')}</span>
  ) : flags.ideas ? (
    <span className={styles.mark}>○ {t('board.start.idea')}</span>
  ) : null;
}

export function QuickPriority({ task }: { task: BoardCard }) {
  const { key, can } = useProject();
  const update = useUpdateTask(key);
  const last = useRef<TaskPriority | null>(null);
  const controls = useRef<HTMLDivElement>(null);
  if (!can.createTasks)
    return task.priority ? (
      <p>
        {t('priority.own')}: {t(`priority.levels.${task.priority}`)}
      </p>
    ) : null;
  const save = (priority: TaskPriority | null) => {
    if (update.isPending) return;
    last.current = priority;
    const focused = document.activeElement;
    const card = controls.current?.closest('[data-card-key]');
    const next = card?.nextElementSibling?.querySelector<HTMLElement>('a');
    const restore = () =>
      requestAnimationFrame(() => {
        if (focused instanceof HTMLElement && focused.isConnected) focused.focus();
        else
          (next?.isConnected
            ? next
            : document.querySelector<HTMLElement>('[data-start-filters] [aria-pressed="true"]')
          )?.focus();
      });
    void update.mutateAsync({ taskKey: task.key, body: { priority } }).then(restore, restore);
  };
  return (
    <div className={styles.editor} ref={controls}>
      <div className={styles.editorHead}>
        <span>{t('priority.own')}</span>
        <button
          className={styles.clear}
          type="button"
          aria-disabled={update.isPending || !task.priority}
          onClick={() => {
            if (task.priority) save(null);
          }}
        >
          {t('priority.clear')}
        </button>
      </div>
      <div
        className={styles.choices}
        role="group"
        aria-label={t('priority.own')}
        aria-busy={update.isPending}
      >
        {TASK_PRIORITIES.map((level) => (
          <button
            key={level}
            type="button"
            aria-pressed={task.priority === level}
            aria-disabled={update.isPending}
            onClick={() => save(level)}
          >
            {t(`priority.levels.${level}`)}
          </button>
        ))}
      </div>
      <span role="status">
        {update.isPending ? t('priority.saving') : update.isSuccess ? t('priority.saved') : ''}
      </span>
      {update.isError ? (
        <div role="alert" className={styles.error}>
          {t('priority.saveFailed')}{' '}
          <button type="button" onClick={() => save(last.current)}>
            {t('priority.retry')}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function StartFilters({
  data,
  tasks,
  value,
  onChange,
}: {
  data: StartConditionData;
  tasks: readonly BoardCard[];
  value: StartFilter;
  onChange: (value: StartFilter) => void;
}) {
  const condition = data.config.team.startCondition!;
  const names = (ids: readonly string[]) =>
    ids.map((id) => data.config.pipeline.labels.find((label) => label.id === id)?.name ?? id).join(', ');
  const forms: string[] = [];
  if (condition.stages)
    forms.push(
      t('board.start.stages', {
        stages: condition.stages
          .map((id) => data.config.pipeline.stages.find((stage) => stage.id === id)?.name ?? id)
          .join(', '),
      }),
    );
  if (condition.priority)
    forms.push(
      condition.priority === 'any'
        ? t('board.start.anyPriority')
        : t('board.start.priorityThreshold', { level: t(`priority.levels.${condition.priority}`) }),
    );
  if (condition.labels) forms.push(t('board.start.labels', { labels: names(condition.labels) }));
  return (
    <section className={styles.section} aria-label={t('board.start.filters')}>
      <div className={styles.filters} data-start-filters>
        {(['all', 'go', 'ideas', 'held'] as const).map((filter) => (
          <button key={filter} type="button" aria-pressed={value === filter} onClick={() => onChange(filter)}>
            {t(`board.start.${filter}`)} ({tasks.filter((task) => startMatches(task, data, filter)).length})
          </button>
        ))}
      </div>
      <p>
        {t('board.start.summary', {
          condition: forms.join(t(condition.combine === 'all' ? 'board.start.and' : 'board.start.or')),
          hold: names(condition.hold) || t('priority.none'),
          minutes: condition.graceMinutes,
        })}
      </p>
      <details>
        <summary>{t('board.startAbout')}</summary>
        <p>{t('board.start.explanation')}</p>
      </details>
    </section>
  );
}
