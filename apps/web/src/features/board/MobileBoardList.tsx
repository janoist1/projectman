import { useLabels } from '../../api/queries';
import type { Task } from '@projectman/shared';
import { StatusDot } from '../../components/Chip';
import { t } from '../../i18n/t';
import type { PlainMessageKey } from '../../i18n/t';
import type { PipelineIndex } from '../../lib/pipeline';
import type { TaskPhase } from '../../lib/taskState';
import { TaskCard } from './TaskCard';
import { sortEntries } from './useBoardModel';
import type { BoardEntry } from './useBoardModel';
import styles from './MobileBoardList.module.css';

const groups: ReadonlyArray<{ id: string; label: PlainMessageKey; phases: TaskPhase[]; dot: TaskPhase }> = [
  { id: 'needs', label: 'board.groups.needsYou', phases: ['needs_you'], dot: 'needs_you' },
  { id: 'working', label: 'board.groups.working', phases: ['working'], dot: 'working' },
  { id: 'waiting', label: 'board.groups.waiting', phases: ['waiting', 'blocked'], dot: 'waiting' },
  { id: 'ready', label: 'board.groups.ready', phases: ['ready'], dot: 'ready' },
  { id: 'done', label: 'board.groups.done', phases: ['done'], dot: 'done' },
];

/** Phone board: tasks grouped by what they wait for, with stage counts on top. */
export function MobileBoardList({
  entries,
  subtasksByParent = new Map(),
  pipeline,
  projectKey,
}: {
  entries: BoardEntry[];
  subtasksByParent?: Map<string, Task[]>;
  pipeline: PipelineIndex;
  projectKey: string;
}) {
  const labels = useLabels(projectKey);
  return (
    <div className={styles.wrap}>
      <ul className={styles.stages} aria-label={t('board.stagesLabel')}>
        {pipeline.columns.map((column) => {
          const count = entries.filter(
            (entry) => pipeline.columnOfStage.get(entry.task.stageId)?.id === column.id,
          ).length;
          return (
            <li key={column.id} className={styles.stage} data-column-color={column.color}>
              <span className={styles.stageDot} aria-hidden="true" />
              <span>{column.name}</span>
              <span className={styles.stageCount}>{count}</span>
            </li>
          );
        })}
      </ul>
      {groups.map((group) => {
        const list = sortEntries(entries.filter((entry) => group.phases.includes(entry.state.phase)));
        if (list.length === 0) return null;
        const headingId = `group-${group.id}`;
        return (
          <section key={group.id} className={styles.group} aria-labelledby={headingId}>
            <div className={styles.groupHead}>
              <StatusDot phase={group.dot} />
              <h2 id={headingId} className={styles.groupName}>
                {t(group.label)}
              </h2>
              <span className={styles.groupCount}>{list.length}</span>
            </div>
            {list.map(({ task, state }) => (
              <TaskCard
                key={task.id}
                task={task}
                subtasks={subtasksByParent.get(task.key)}
                state={state}
                pipeline={pipeline}
                to={`/p/${projectKey}/tasks/${task.key}`}
                labels={labels}
                compact
              />
            ))}
          </section>
        );
      })}
    </div>
  );
}
