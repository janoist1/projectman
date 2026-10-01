import { useState } from 'react';
import { useLabels } from '../../api/queries';
import type { Task } from '@projectman/shared';
import { Button } from '../../components/Button';
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

/** How many of the newest finished tasks the collapsed "Kész" group shows. */
export const DONE_PREVIEW = 3;

/**
 * Phone board: tasks grouped by what they wait for. The finished group is collapsed to its
 * newest few; a search shows every match.
 */
export function MobileBoardList({
  entries,
  subtasksByParent = new Map(),
  pipeline,
  projectKey,
  searching = false,
}: {
  entries: BoardEntry[];
  subtasksByParent?: Map<string, Task[]>;
  pipeline: PipelineIndex;
  projectKey: string;
  searching?: boolean;
}) {
  const labels = useLabels(projectKey);
  const [doneExpanded, setDoneExpanded] = useState(false);
  return (
    <div className={styles.wrap}>
      {groups.map((group) => {
        const list = sortEntries(entries.filter((entry) => group.phases.includes(entry.state.phase)));
        if (list.length === 0) return null;
        const headingId = `group-${group.id}`;
        const collapsible = group.id === 'done' && !searching && list.length > DONE_PREVIEW;
        const shown = collapsible && !doneExpanded ? list.slice(0, DONE_PREVIEW) : list;
        return (
          <section key={group.id} className={styles.group} aria-labelledby={headingId}>
            <div className={styles.groupHead}>
              <StatusDot phase={group.dot} />
              <h2 id={headingId} className={styles.groupName}>
                {t(group.label)}
              </h2>
              <span className={styles.groupCount}>{list.length}</span>
            </div>
            {shown.map(({ task, state }) => (
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
            {collapsible ? (
              <Button
                variant="muted"
                size="sm"
                fullWidth
                aria-expanded={doneExpanded}
                onClick={() => setDoneExpanded((open) => !open)}
              >
                {doneExpanded ? t('board.doneFewer') : t('board.doneAll', { count: list.length })}
              </Button>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
