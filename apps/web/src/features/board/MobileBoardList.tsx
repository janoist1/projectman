import { useLabels } from '../../api/queries';
import type { Task } from '@projectman/shared';
import { StatusDot } from '../../components/Chip';
import { t } from '../../i18n/t';
import type { PlainMessageKey } from '../../i18n/t';
import type { MemberIndex } from '../../lib/members';
import type { PipelineIndex } from '../../lib/pipeline';
import type { TaskPhase } from '../../lib/taskState';
import { coverSrcOf } from './cardModel';
import { useDoneFold } from './doneFold';
import { TaskCard } from './TaskCard';
import { sortGroupEntries } from './useBoardModel';
import type { BoardEntry } from './useBoardModel';
import styles from './MobileBoardList.module.css';

const groups: ReadonlyArray<{ id: string; label: PlainMessageKey; phases: TaskPhase[]; dot: TaskPhase }> = [
  { id: 'needs', label: 'board.groups.needsYou', phases: ['needs_you'], dot: 'needs_you' },
  { id: 'working', label: 'board.groups.working', phases: ['working'], dot: 'working' },
  { id: 'waiting', label: 'board.groups.waiting', phases: ['waiting', 'blocked'], dot: 'waiting' },
  { id: 'ready', label: 'board.groups.ready', phases: ['ready'], dot: 'ready' },
  { id: 'done', label: 'board.groups.done', phases: ['done'], dot: 'done' },
];

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
  members,
  myHandle,
}: {
  entries: BoardEntry[];
  subtasksByParent?: Map<string, Task[]>;
  pipeline: PipelineIndex;
  projectKey: string;
  searching?: boolean;
  members?: MemberIndex;
  myHandle?: string | null;
}) {
  const labels = useLabels(projectKey);
  // The finished cards are those in the "done" phase (a done stage or a closed card), not those named "Kész".
  const done = useDoneFold(
    sortGroupEntries(
      entries.filter((entry) => entry.state.phase === 'done'),
      pipeline,
    ),
    searching,
  );
  return (
    <div className={styles.wrap}>
      {groups.map((group) => {
        const list = sortGroupEntries(
          entries.filter((entry) => group.phases.includes(entry.state.phase)),
          pipeline,
        );
        if (list.length === 0) return null;
        const headingId = `group-${group.id}`;
        const isDone = group.id === 'done';
        const shown = isDone ? done.shown : list;
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
                coverSrc={coverSrcOf(projectKey, task)}
                members={members}
                myHandle={myHandle}
                compact
              />
            ))}
            {isDone ? done.toggle : null}
          </section>
        );
      })}
    </div>
  );
}
